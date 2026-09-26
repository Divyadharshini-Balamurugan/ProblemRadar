import { z } from "zod";

import type { IntentScope, ResearchHypothesis, ResearchPlan, SearchBudget } from "@/types";
import { RESEARCH_LENSES } from "@/types";
import { extractJsonObject } from "./json-utils";
import { getLLMProvider } from "./index";
import { withRetry } from "./with-retry";

/**
 * Thrown when the model responded, but its text wasn't valid JSON, the
 * JSON didn't match the expected ResearchPlan structure (even after the
 * deterministic repair pass below), or it violated one of the
 * deterministic sanity rules further down (duplicate ids, a lens reused
 * twice, near-identical hypotheses, repeated search queries, a stale year
 * in a search query when time_scope is "current", a search query with no
 * hypothesis-specific anchor word (see `assertSearchQueriesAreGrounded`),
 * too many/few hypotheses). Distinct from `LLMConnectionError` (couldn't
 * reach the model at all).
 */
export class ResearchPlanParseError extends Error {
  constructor(
    message: string,
    /** The raw, unparsed text the model returned — useful for debugging. */
    public readonly raw: string
  ) {
    super(message);
    this.name = "ResearchPlanParseError";
  }
}

/** A "small, diverse set" — enough to cover distinct angles without sprawling. */
export const MIN_HYPOTHESES = 3;
export const MAX_HYPOTHESES = 7;

/**
 * Short definitions given to the model so lens choice is grounded, not
 * guessed. Kept terse on purpose — this is prompt/input text, and overall
 * prompt+output brevity is a deliberate latency lever for CPU-only local
 * inference (see `MAX_ATTEMPTS` and the field-length caps below).
 */
const LENS_DEFINITIONS: Record<(typeof RESEARCH_LENSES)[number], string> = {
  time: "too slow / wastes time",
  cost: "too expensive / costs add up",
  manual_work: "manual task that could be automated",
  availability: "resource/service unavailable when needed",
  access: "hard to reach or qualify for something",
  coordination: "parties struggle to stay in sync",
  information: "hard to find/verify needed info",
  reliability: "breaks down or behaves inconsistently",
  trust: "lack of trust — fraud, scams, no verification",
  compliance: "friction from regulatory/legal/policy rules",
  workflow: "broken or inefficient process/handoff",
  existing_solution_failure: "current tools exist but fail to meet the need",
  workaround: "inefficient manual workaround in place of a real solution",
};

const LENS_CATALOG = RESEARCH_LENSES.map((lens) => `- "${lens}": ${LENS_DEFINITIONS[lens]}`).join("\n");

/**
 * Explicit guardrail against a real, observed failure mode: Qwen3
 * sometimes fills "lens" with the *domain/topic/technology* being
 * researched (e.g. "infrastructure", "connectivity", "healthcare")
 * instead of picking one of the 13 fixed mechanism-type values above.
 * Spelling out the distinction plus concrete examples — rather than
 * relying on the catalog's one-line definitions alone — is the primary
 * fix; the deterministic repair pass further down is only a narrow,
 * formatting-only safety net, not a substitute for the model getting
 * this right.
 */
const LENS_GUIDANCE = `"lens" is the TYPE of problem — the mechanism by which it hurts people — never the domain, topic, technology, infrastructure, or population being studied. It must be exactly one of the identifiers listed above, verbatim (lowercase, underscores). Never invent a new value like "infrastructure", "connectivity", or "technology" — those are not lenses. Examples: rural broadband being unreliable → "reliability" (not "infrastructure"); people living far from healthcare → "access"; not enough doctors available → "availability"; a process still done on paper → "manual_work"; agencies failing to coordinate with each other → "coordination"; people unaware a government scheme exists → "information"; an existing app/service that exists but fails to meet the need → "existing_solution_failure".`;

/**
 * Structural validation for one hypothesis. `hypothesis` has a minimum
 * length (against generic one-line filler like "there are inefficiencies")
 * and a maximum (against rambling) — both soft levers toward the concrete,
 * falsifiable, *concise* claims the prompt asks for. `evidence_targets`,
 * `source_strategies`, and `search_queries` are capped at 3 each (down
 * from an earlier 5): this is the main latency lever, since output length
 * — not prompt length — dominates CPU-bound local-model generation time.
 */
const HypothesisSchema = z.object({
  id: z.string().min(1),
  lens: z.enum(RESEARCH_LENSES),
  hypothesis: z.string().min(30).max(220),
  evidence_targets: z.array(z.string().min(1).max(80)).min(2).max(3),
  source_strategies: z.array(z.string().min(1).max(80)).min(2).max(3),
  search_queries: z.array(z.string().min(3).max(120)).min(2).max(3),
}) satisfies z.ZodType<ResearchHypothesis>;

/**
 * The LLM produces the whole hypothesis list (id included — see the
 * deterministic repair pass below for why `id` still needs a safety net).
 * `search_budget` is separately deterministic, computed in code from
 * `breadth` and the hypothesis count — that's arithmetic/bookkeeping a
 * model doesn't need to "reason" about, and computing it ourselves means
 * it's always internally consistent and never fails validation.
 */
const PlannerOutputSchema = z.object({
  hypotheses: z.array(HypothesisSchema).min(MIN_HYPOTHESES).max(MAX_HYPOTHESES),
});

// Deliberately terse: this is a system prompt for a small, CPU-bound
// local model, and prompt/output brevity is the main latency lever.
// "Output ONLY JSON" is stated up front and repeated at the end of the
// user prompt, since some models attend to the trailing instruction most.
const SYSTEM_PROMPT = `You are the Research Planner inside ProblemRadar. You receive a validated Intent/Scope JSON object and turn it into a small, diverse set of concrete, falsifiable research hypotheses (each on one distinct "lens"), each with public evidence targets, public source types, and candidate search queries. You do not run any search or judge whether the problem is real — only plan what to investigate and how. Output ONLY the JSON object: no prose, no markdown fences, no <think> reasoning, no explanation.`;

function buildPrompt(intent: IntentScope): string {
  const locationRule = intent.location
    ? `Location is "${intent.location}" — name it in every hypothesis and search query.`
    : `No location given — do not invent one.`;

  // Aligned with `assertSearchQueriesAreCurrent`'s own cutoff (anything
  // older than last year is rejected as stale) so the prompt never
  // promises leeway the deterministic check won't actually allow.
  const timeScopeIsCurrent = intent.time_scope.trim().toLowerCase().includes("current");
  const currentYear = new Date().getFullYear();
  const timeRule = timeScopeIsCurrent
    ? `time_scope is "current": prefer "recent"/"latest"/"current" phrasing over a specific year in search queries — do not add a year just out of habit. Only include a year at all if a hypothesis genuinely needs to cite a specific past reporting period, and even then only ${currentYear} or ${currentYear - 1} is allowed — never an older year (e.g. ${currentYear - 2}) unless the hypothesis is explicitly about a historical comparison.`
    : `Match years/timeframes in search queries to "time_scope" ("${intent.time_scope}").`;

  const queryRule = `"search_queries" (2-3): build every query from the hypothesis, evidence_targets, and source_strategies. Keep each within 120 characters. Every query must identify the affected population and setting, the exact service/actor and mechanism in the hypothesis, a measurable indicator where applicable, and the evidence/source type sought. State the relationship being investigated (for example, compare the named service's cost, wait, distance, or failure rate between two populations; do not just place "rural" beside "cost"). Broad words such as "opportunity", "rural", "urban", "cost", "access", "platform", and "resources" are not enough by themselves: connect them to a specific population, service, and outcome so they cannot point to unrelated brands, entertainment, dictionaries, or products. Use concrete symptoms rather than lens labels or abstract terms like "availability", "reliability", "coordination", "challenges", or "gaps". Name the requested evidence artifact (e.g. a service-cost comparison study, patient-wait survey, outage complaint records, administrative dataset, audit, or documented cases), not vague "public information". Keep the 2-3 queries complementary: target distinct evidence types or indicators that could each test the same hypothesis, rather than rephrasing one search. Avoid dictionary/definition/meaning wording and generic informational questions. Do not name a specific website or use a "site:" filter unless one of source_strategies explicitly calls for that exact source. With current scope, do not append years by habit; use recent/current/latest only if helpful. ${locationRule} ${timeRule}`;

  return `Intent/Scope:
${JSON.stringify(intent)}

Lenses (pick only the ones relevant here; each used at most once):
${LENS_CATALOG}

${LENS_GUIDANCE}

Produce ${MIN_HYPOTHESES}-${MAX_HYPOTHESES} hypotheses. Rules:
1. Each hypothesis: one concrete, falsifiable, specific claim — no vague words like "inefficiencies" or "gaps"; name the actual mechanism/process/group. Time-bound to time_scope.
2. "lens": exactly one identifier from the Lenses list above, verbatim — the TYPE of problem, never the domain/topic/technology/infrastructure (see guidance above).
3. "id": short unique string ("h1", "h2", ...).
4. "evidence_targets" (2-3): PUBLIC evidence only — recent news, gov/municipal reports, official announcements, tenders, RTI disclosures, citizen complaints, open datasets, surveys, reviews. Never internal-only records.
5. "source_strategies" (2-3): realistic public source types (not real URLs).
6. ${queryRule}

Output ONLY this JSON shape, nothing else:
{"hypotheses":[{"id":"h1","lens":"<lens>","hypothesis":"...","evidence_targets":["...","..."],"source_strategies":["...","..."],"search_queries":["...","..."]}]}`;
}

function normalizeForComparison(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2) // drop tiny stopword-like tokens
  );
}

/** Jaccard similarity over word sets — good enough to catch reworded near-duplicates. */
function similarity(a: string, b: string): number {
  const setA = normalizeForComparison(a);
  const setB = normalizeForComparison(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Hypotheses this similar are treated as "near-identical" and rejected. */
const NEAR_DUPLICATE_THRESHOLD = 0.6;

/** Field names a hypothesis object is allowed to have. Used by the repair pass below. */
const KNOWN_HYPOTHESIS_KEYS = new Set([
  "id",
  "lens",
  "hypothesis",
  "evidence_targets",
  "source_strategies",
  "search_queries",
]);

/**
 * Deterministic, conservative repair for a specific, observed Ollama/
 * Qwen3 quirk under `format: "json"`: a hypothesis's "id" key sometimes
 * comes back corrupted into a stray punctuation/whitespace-only key
 * (e.g. `{ " ": "h3", ... }` or `{ ",": "h3", ... }`) while the id's
 * *value* and every other field stay intact.
 *
 * This renames that stray key back to "id" only when the pattern is
 * unambiguous: the object is missing a valid "id", and has exactly one
 * unexpected key whose name is punctuation/whitespace only, holding a
 * short id-shaped string value. It never invents an id value that wasn't
 * already present in some form, and never touches any other field or
 * hypothesis — anything less certain is left alone, for schema
 * validation (and ultimately a retry to the model) to catch instead.
 *
 * Runs once per attempt, between `JSON.parse` and schema validation, and
 * only on the first schema-validation failure of that attempt.
 */
function repairMalformedHypothesisIds(parsed: unknown): { repaired: unknown; wasRepaired: boolean } {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("hypotheses" in parsed) ||
    !Array.isArray((parsed as { hypotheses: unknown }).hypotheses)
  ) {
    return { repaired: parsed, wasRepaired: false };
  }

  let wasRepaired = false;

  const hypotheses = (parsed as { hypotheses: unknown[] }).hypotheses.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;

    const obj = item as Record<string, unknown>;
    const hasValidId = typeof obj.id === "string" && obj.id.trim().length > 0;
    if (hasValidId) return obj;

    const strayEntries = Object.entries(obj).filter(
      ([key, value]) =>
        !KNOWN_HYPOTHESIS_KEYS.has(key) &&
        /^[\s,.:;_-]{1,3}$/.test(key) &&
        typeof value === "string" &&
        /^[a-zA-Z][\w-]{0,15}$/.test(value.trim())
    );

    if (strayEntries.length !== 1) return obj;

    const [strayKey, strayValue] = strayEntries[0];
    const rest = { ...obj };
    delete rest[strayKey];
    wasRepaired = true;
    return { ...rest, id: (strayValue as string).trim() };
  });

  return { repaired: { ...(parsed as Record<string, unknown>), hypotheses }, wasRepaired };
}

/** The 13 valid lens identifiers, for cheap membership checks in the repair pass below. */
const LENS_SET: ReadonlySet<string> = new Set(RESEARCH_LENSES);

/**
 * Normalizes a "lens" string to a valid lens identifier ONLY when it's an
 * unambiguous *formatting* variant of one (different case, spaces/hyphens
 * instead of underscores, or a trivial plural) — e.g. "Manual Work" or
 * "workarounds". Returns `null` for anything else, including a
 * genuinely different word like "infrastructure": that doesn't map 1:1 to
 * any single lens, so guessing one would be inventing content, which this
 * repair layer must never do (per the "never blindly map arbitrary
 * invalid lens values" rule). The real fix for that case is the
 * strengthened prompt (`LENS_GUIDANCE`) — this is only a narrow
 * formatting safety net on top of it.
 */
function normalizeLensCandidate(raw: string): (typeof RESEARCH_LENSES)[number] | null {
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (LENS_SET.has(normalized)) {
    return normalized as (typeof RESEARCH_LENSES)[number];
  }
  // A trivial plural of an otherwise-exact match (e.g. "workarounds" -> "workaround").
  if (normalized.endsWith("s") && LENS_SET.has(normalized.slice(0, -1))) {
    return normalized.slice(0, -1) as (typeof RESEARCH_LENSES)[number];
  }
  return null;
}

/**
 * Deterministic, conservative repair for a hypothesis's "lens" value.
 * Only ever rewrites a formatting-only mismatch (see
 * `normalizeLensCandidate`) — a value with no unambiguous match (e.g.
 * "infrastructure", "technology", "healthcare") is left exactly as-is,
 * logged, and allowed to fail schema validation so it triggers a retry
 * to the model instead of being silently guessed at.
 *
 * Every invalid value seen is logged with the repair decision (repaired
 * to X, or left alone because no safe mapping exists), independent of
 * whether the repair actually changes the outcome for this attempt.
 */
function repairInvalidLensValues(parsed: unknown, attemptNumber: number): { repaired: unknown; wasRepaired: boolean } {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("hypotheses" in parsed) ||
    !Array.isArray((parsed as { hypotheses: unknown }).hypotheses)
  ) {
    return { repaired: parsed, wasRepaired: false };
  }

  let wasRepaired = false;

  const hypotheses = (parsed as { hypotheses: unknown[] }).hypotheses.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;

    const obj = item as Record<string, unknown>;
    const lensValue = obj.lens;
    // Not a string, or already a valid lens — nothing for this pass to do.
    if (typeof lensValue !== "string" || LENS_SET.has(lensValue)) return obj;

    const hypothesisId = typeof obj.id === "string" && obj.id.trim() ? obj.id : "?";
    const canonical = normalizeLensCandidate(lensValue);

    if (canonical) {
      console.log(
        `[ProblemRadar/ResearchPlanner] attempt ${attemptNumber}/${MAX_ATTEMPTS}: invalid lens "${lensValue}" on hypothesis "${hypothesisId}" — repairing to "${canonical}" (formatting-only mismatch: case/separator/plural)`
      );
      wasRepaired = true;
      return { ...obj, lens: canonical };
    }

    console.warn(
      `[ProblemRadar/ResearchPlanner] attempt ${attemptNumber}/${MAX_ATTEMPTS}: invalid lens "${lensValue}" on hypothesis "${hypothesisId}" — not a recognizable formatting variant of any known lens; leaving it as-is for schema validation to reject rather than guessing a semantic mapping`
    );
    return obj;
  });

  return { repaired: { ...(parsed as Record<string, unknown>), hypotheses }, wasRepaired };
}

/**
 * Deterministic sanity checks beyond structural schema validation: unique
 * ids, one hypothesis per lens, no two hypotheses that are obvious
 * rewordings of each other, and no search query repeated verbatim
 * anywhere in the plan. Throws `ResearchPlanParseError` on the first
 * violation found.
 */
function assertHypothesesAreSound(hypotheses: ResearchHypothesis[], raw: string): void {
  const seenIds = new Set<string>();
  const seenLenses = new Set<string>();
  const seenQueries = new Set<string>();

  for (const h of hypotheses) {
    if (seenIds.has(h.id)) {
      throw new ResearchPlanParseError(`Duplicate hypothesis id "${h.id}".`, raw);
    }
    seenIds.add(h.id);

    if (seenLenses.has(h.lens)) {
      throw new ResearchPlanParseError(
        `Lens "${h.lens}" is used by more than one hypothesis — each hypothesis must use a distinct lens.`,
        raw
      );
    }
    seenLenses.add(h.lens);

    for (const query of h.search_queries) {
      const normalized = query.trim().toLowerCase();
      if (seenQueries.has(normalized)) {
        throw new ResearchPlanParseError(
          `Search query "${query}" is repeated across the plan — search queries must be diverse, not reused verbatim.`,
          raw
        );
      }
      seenQueries.add(normalized);
    }
  }

  for (let i = 0; i < hypotheses.length; i++) {
    for (let j = i + 1; j < hypotheses.length; j++) {
      const score = similarity(hypotheses[i].hypothesis, hypotheses[j].hypothesis);
      if (score >= NEAR_DUPLICATE_THRESHOLD) {
        throw new ResearchPlanParseError(
          `Hypotheses "${hypotheses[i].id}" and "${hypotheses[j].id}" are near-identical (word-overlap ${score.toFixed(2)}) — the planner must produce genuinely distinct hypotheses.`,
          raw
        );
      }
    }
  }
}

/**
 * Words a search query can be built from without actually saying anything
 * specific about the hypothesis at hand — locations, filler, and the kind
 * of generic connective tissue that would make "coordination rural India"
 * look sufficiently "grounded" even though it's still just the lens word
 * plus a place. Deliberately excludes evidence-type words too (e.g.
 * "report", "survey"): those describe the *kind* of source wanted, not the
 * hypothesis's own specific mechanism/institution/population, which is
 * what `assertSearchQueriesAreGrounded` below actually checks for.
 */
const GENERIC_QUERY_TERMS: ReadonlySet<string> = new Set([
  "rural",
  "india",
  "indian",
  "current",
  "recent",
  "latest",
  "government",
  "problem",
  "problems",
  "issue",
  "issues",
  "area",
  "areas",
  "access",
  "service",
  "services",
  "need",
  "needs",
  "needed",
  "lack",
  "lacking",
  "real",
  "worth",
  "solving",
  "right",
  "today",
  "people",
  "community",
  "communities",
  "country",
  "state",
  "states",
  "district",
  "districts",
  "village",
  "villages",
  "town",
  "towns",
  "local",
  "national",
  "public",
  "private",
  "situation",
  "challenge",
  "challenges",
  "concern",
  "concerns",
  "impact",
  "impacts",
  "affect",
  "affects",
  "affected",
  "level",
  "levels",
  "based",
  "related",
  "information",
  "data",
  "report",
  "reports",
  "study",
  "studies",
  "survey",
  "surveys",
  "news",
  "update",
  "updates",
  "year",
  "years",
  "time",
  "times",
  "across",
  "among",
  "many",
  "most",
  "some",
  "still",
  "also",
  "being",
  "without",
  "despite",
  "facing",
  "face",
  "faces",
  "common",
  "major",
]);

/**
 * Crude, deliberately conservative suffix-stripping so a trivial
 * morphological variant ("tracking" vs "track", "spreadsheets" vs
 * "spreadsheet", "freelancers" vs "freelancer") still counts as the same
 * word for the groundedness comparison below — a hypothesis's own text and
 * a query built from it very often differ only by verb form or plural,
 * and treating those as unrelated words would make the check reject
 * perfectly specific queries for the wrong reason. Same spirit as
 * `normalizeLensCandidate`'s trivial-plural handling, just applied to
 * arbitrary words instead of the fixed lens vocabulary.
 */
function stem(word: string): string {
  if (word.length > 6 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith("ed") && !word.endsWith("eed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Substantive (4+ letter) word stems, same length convention as the Evidence Analyzer's `normalizeWords`. */
function extractSubstantiveWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3)
      .map(stem)
  );
}

/**
 * `GENERIC_QUERY_TERMS` is written as plain, readable words above (many
 * already listing both singular and plural forms). Since
 * `extractSubstantiveWords` now stems every word it extracts, the
 * blocklist has to go through the same `stem()` function to stay
 * comparable — otherwise a stemmed vocabulary word ("challenging" ->
 * "challeng") could fail to match its own unstemmed blocklist entry
 * ("challenges") purely as a stemming artifact, letting a generic word
 * slip through as if it were a real anchor.
 */
const GENERIC_QUERY_TERMS_STEMMED: ReadonlySet<string> = new Set([...GENERIC_QUERY_TERMS].map(stem));

/**
 * Word families derived from each lens's own identifier/definition (see
 * `LENS_DEFINITIONS`). A hypothesis's own `evidence_targets` or
 * `source_strategies` will very naturally reuse the lens's own word — e.g.
 * a "coordination" hypothesis's evidence_targets legitimately says
 * "...coordination complaints" — so that word alone can NOT be trusted as
 * a "specific to this hypothesis" anchor the way `assertSearchQueriesAreGrounded`
 * needs: a search query built from nothing but that reused word plus a
 * location (the reported failure) would otherwise still pass. These are
 * excluded from `specificAnchors` per-hypothesis (by that hypothesis's own
 * `lens`), on top of the always-excluded `GENERIC_QUERY_TERMS`.
 */
const LENS_WORD_FAMILIES: Record<(typeof RESEARCH_LENSES)[number], string[]> = {
  time: ["time", "times", "timing", "slow", "slower", "wastes", "wasting", "wasted"],
  cost: ["cost", "costs", "costly", "expensive", "expense", "expenses", "afford", "affordable"],
  manual_work: ["manual", "automate", "automated", "automation", "task", "tasks"],
  availability: ["availability", "available", "unavailable", "resource", "resources"],
  access: ["access", "accessible", "inaccessible", "reach", "qualify", "qualifies", "qualifying"],
  coordination: [
    "coordination",
    "coordinate",
    "coordinated",
    "coordinating",
    "coordinators",
    "sync",
    "synchronize",
    "synchronise",
  ],
  information: ["information", "informed", "uninformed", "unaware", "awareness", "verify", "verified", "verifying"],
  reliability: ["reliability", "reliable", "unreliable", "breaks", "breakdown", "inconsistent", "inconsistently"],
  trust: ["trust", "trusted", "distrust", "fraud", "scam", "scams", "verification"],
  compliance: ["compliance", "compliant", "noncompliance", "regulatory", "regulation", "regulations", "policy", "policies"],
  workflow: ["workflow", "workflows", "process", "processes", "handoff", "handoffs", "inefficient", "inefficiency"],
  existing_solution_failure: ["existing", "solution", "solutions", "fails", "failing", "meet"],
  workaround: ["workaround", "workarounds", "inefficient"],
};

/**
 * Deterministic guardrail against a real, observed failure mode: a search
 * query built from nothing but the lens's generic term plus a location
 * (e.g. "coordination rural India") is ambiguous enough to pull back
 * unrelated results — song lyrics, dictionary pages, project-management
 * software — instead of evidence about the actual hypothesis.
 *
 * This checks the query on its own terms: strip out `GENERIC_QUERY_TERMS`
 * (location/filler/evidence-type words) and that hypothesis's own
 * `LENS_WORD_FAMILIES` (the lens's own vocabulary, which says nothing
 * hypothesis-specific even when it legitimately appears in the query), and
 * require at least one substantive (4+ letter) word to still be standing.
 *
 * An earlier version of this check instead required the query to share a
 * word with the hypothesis's own "hypothesis"/evidence_targets/
 * source_strategies text. That over-fit: a plan's second or third query
 * for the same hypothesis is *supposed* to probe a different angle in
 * different words (e.g. "healthcare staffing government data" alongside
 * "doctor shortage report") — reusing none of the hypothesis's exact
 * wording doesn't make a query ambiguous, and penalizing that punished
 * exactly the query diversity the planner is asked for. Checking the
 * query's own residual content instead still catches the real failure
 * mode (nothing distinctive left once the lens word and boilerplate are
 * removed) without objecting to legitimate synonyms/angles.
 */
function assertSearchQueriesAreGrounded(hypotheses: ResearchHypothesis[], raw: string): void {
  for (const h of hypotheses) {
    const lensFamily = new Set((LENS_WORD_FAMILIES[h.lens] ?? []).map(stem));

    for (const query of h.search_queries) {
      const queryWords = extractSubstantiveWords(query);
      const hasAnchor = [...queryWords].some(
        (word) => !GENERIC_QUERY_TERMS_STEMMED.has(word) && !lensFamily.has(word)
      );
      if (!hasAnchor) {
        throw new ResearchPlanParseError(
          `Search query "${query}" (hypothesis "${h.id}") has nothing specific left once generic and lens-boilerplate words are stripped — it reads as a bare lens/location query that could match unrelated results (e.g. a bare "coordination" query can return song lyrics or project-management software instead of the intended government-coordination failure). Ground it in the actual mechanism, institution, or population involved.`,
          raw
        );
      }
    }
  }
}

/** Matches a bare 4-digit year (1900-2099) anywhere in a string. */
const YEAR_PATTERN = /\b(19|20)\d{2}\b/g;

/**
 * Deterministic check for a specific quality issue: when the scope's
 * `time_scope` is "current", a search query referencing an old year (e.g.
 * "2023" when the current year is 2026) is a model hallucination, not a
 * deliberate historical reference — reject it rather than let it reach a
 * future search-execution stage. Only enforced when `time_scope` actually
 * says "current"; any other `time_scope` value is left alone, since the
 * model may legitimately be citing a year that scope calls for.
 */
function assertSearchQueriesAreCurrent(
  hypotheses: ResearchHypothesis[],
  intent: IntentScope,
  raw: string
): void {
  if (!intent.time_scope.trim().toLowerCase().includes("current")) return;

  // Allow this year and last year as "current enough" (e.g. a citation of
  // last fiscal year's report) — only anything older counts as stale.
  const minAllowedYear = new Date().getFullYear() - 1;

  for (const h of hypotheses) {
    for (const query of h.search_queries) {
      const staleYears = (query.match(YEAR_PATTERN) ?? []).filter((year) => Number(year) < minAllowedYear);
      if (staleYears.length > 0) {
        throw new ResearchPlanParseError(
          `Search query "${query}" (hypothesis "${h.id}") references a stale year (${staleYears.join(", ")}) even though time_scope is "current" — use recent/current phrasing instead.`,
          raw
        );
      }
    }
  }
}

/**
 * Computed, not generated: a reasonable search budget derived from the
 * scope's breadth and how many hypotheses ended up in the plan. A future
 * search-execution stage can use this to cap how many of each
 * hypothesis's `search_queries` it actually runs. Keeping this
 * deterministic means it's always internally consistent and never a
 * source of validation failure.
 */
function computeSearchBudget(intent: IntentScope, hypothesisCount: number): SearchBudget {
  // `breadth` is free text from stage 1 (not a strict enum), so match
  // loosely rather than assuming an exact value.
  const breadth = intent.breadth.trim().toLowerCase();
  const perHypothesisQueries = breadth.includes("narrow") ? 3 : breadth.includes("broad") ? 5 : 4; // exploratory / anything else

  return {
    max_queries_per_hypothesis: perHypothesisQueries,
    max_sources_per_hypothesis: 5,
    total_query_budget: perHypothesisQueries * hypothesisCount,
  };
}

/**
 * How many times to ask the model again if its JSON doesn't parse,
 * validate (even after the deterministic repair pass), or pass the
 * soundness checks. `format: "json"` only guarantees syntactically valid
 * JSON, not a specific shape — with several nested objects required per
 * response, an occasional missing/garbled field is expected. Retrying
 * once is usually enough since generation isn't deterministic.
 */
const MAX_ATTEMPTS = 2;

/**
 * Stage 2 of the ProblemRadar research pipeline: turn a validated
 * Intent/Scope object into a validated ResearchPlan. Still no web search
 * — this only decides what would be worth investigating, with what
 * evidence, and what someone would search for to check it.
 */
export async function generateResearchPlan(intent: IntentScope): Promise<ResearchPlan> {
  const provider = getLLMProvider();
  const startedAt = Date.now();
  let attemptsUsed = 0;

  const hypotheses = await withRetry(
    async (attemptNumber) => {
      const raw = await provider.generateJSON({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(intent),
        temperature: 0.3,
      });

      console.log(
        `[ProblemRadar/ResearchPlanner] attempt ${attemptNumber}/${MAX_ATTEMPTS} — raw model output:\n${raw}`
      );

      const jsonText = extractJsonObject(raw);

      let parsedUnknown: unknown;
      try {
        parsedUnknown = JSON.parse(jsonText);
      } catch {
        throw new ResearchPlanParseError(
          `The model (${provider.name}) did not return valid JSON (attempt ${attemptNumber}/${MAX_ATTEMPTS}).`,
          raw
        );
      }

      let result = PlannerOutputSchema.safeParse(parsedUnknown);
      const repairsApplied: string[] = [];

      if (!result.success) {
        console.warn(
          `[ProblemRadar/ResearchPlanner] attempt ${attemptNumber}/${MAX_ATTEMPTS}: schema validation failed: ${result.error.message}`
        );

        // Pass 1: a hypothesis's "id" key corrupted into stray punctuation.
        let candidate = parsedUnknown;
        const idRepair = repairMalformedHypothesisIds(candidate);
        if (idRepair.wasRepaired) {
          repairsApplied.push('malformed "id" key');
          candidate = idRepair.repaired;
          console.log(
            `[ProblemRadar/ResearchPlanner] attempt ${attemptNumber}/${MAX_ATTEMPTS}: applying deterministic repair for a malformed "id" key, then re-validating`
          );
          result = PlannerOutputSchema.safeParse(candidate);
        }

        // Pass 2: a hypothesis's "lens" value that's a formatting-only
        // mismatch of a real lens. Tried whenever still invalid, whether
        // or not pass 1 fired — a response can have either problem, or
        // both, independently. Always runs (not gated on "still failing"
        // only) so every invalid lens value gets logged, even ones this
        // pass can't safely fix.
        const lensRepair = repairInvalidLensValues(candidate, attemptNumber);
        if (lensRepair.wasRepaired) {
          repairsApplied.push("lens formatting");
          candidate = lensRepair.repaired;
        }
        if (!result.success) {
          result = PlannerOutputSchema.safeParse(candidate);
        }

        if (repairsApplied.length > 0) {
          console.log(
            `[ProblemRadar/ResearchPlanner] attempt ${attemptNumber}/${MAX_ATTEMPTS}: post-repair (${repairsApplied.join(", ")}) validation ${
              result.success ? "passed" : "failed"
            }`
          );
        } else {
          console.log(
            `[ProblemRadar/ResearchPlanner] attempt ${attemptNumber}/${MAX_ATTEMPTS}: no deterministic repair applied (no unambiguous repairable pattern found)`
          );
        }
      } else {
        console.log(
          `[ProblemRadar/ResearchPlanner] attempt ${attemptNumber}/${MAX_ATTEMPTS}: schema validation passed`
        );
      }

      if (!result.success) {
        throw new ResearchPlanParseError(
          `The model's JSON did not match the expected ResearchPlan structure${
            repairsApplied.length > 0 ? ` even after deterministic repair (${repairsApplied.join(", ")})` : ""
          }: ${result.error.message}`,
          raw
        );
      }

      assertHypothesesAreSound(result.data.hypotheses, raw);
      assertSearchQueriesAreCurrent(result.data.hypotheses, intent, raw);
      assertSearchQueriesAreGrounded(result.data.hypotheses, raw);

      attemptsUsed = attemptNumber;
      return result.data.hypotheses;
    },
    {
      maxAttempts: MAX_ATTEMPTS,
      isRetryable: (error) => error instanceof ResearchPlanParseError,
      onRetry: (attemptNumber, error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[ProblemRadar/ResearchPlanner] attempt ${attemptNumber}/${MAX_ATTEMPTS} failed validation (retrying — ${MAX_ATTEMPTS - attemptNumber} attempt(s) left): ${message}`
        );
      },
    }
  );

  const latencyMs = Date.now() - startedAt;
  console.log(
    `[ProblemRadar/ResearchPlanner] done in ${latencyMs}ms using ${attemptsUsed}/${MAX_ATTEMPTS} LLM attempt(s)`
  );

  return {
    hypotheses,
    search_budget: computeSearchBudget(intent, hypotheses.length),
  };
}
