import { z } from "zod";

import type {
  EvidenceAnalysisRun,
  EvidenceRecency,
  EvidenceRelevance,
  EvidenceStance,
  HypothesisEvidenceAnalysis,
  ResearchHypothesis,
  ResearchPlan,
  SearchResult,
  SearchRun,
  SourceEvidence,
} from "@/types";
// Runtime enum constants use a relative specifier (not "@/types") so the
// compiled output also resolves under plain `node --test` (the "@/*" alias
// is a tsconfig-only path mapping).
import { EVIDENCE_RELEVANCE_LEVELS, EVIDENCE_STANCES } from "../../types";
import { extractJsonObject } from "./json-utils";
import { getLLMProvider, LLMConnectionError, type LLMProvider } from "./index";
import { withRetry } from "./with-retry";

/**
 * Thrown when the model responded, but its text wasn't valid JSON, the
 * JSON didn't match the expected per-hypothesis evidence structure (wrong
 * shape, wrong/duplicate/missing source indices), or an entry's
 * `evidence_summary` didn't actually ground in the source it claims to
 * summarize. Distinct from `LLMConnectionError` (couldn't reach the model
 * at all) — this stage's `runEvidenceAnalyzer` catches this per hypothesis
 * so one bad response never aborts the whole run (see below).
 */
export class EvidenceAnalysisParseError extends Error {
  constructor(
    message: string,
    /** The raw, unparsed text the model returned — useful for debugging. */
    public readonly raw: string
  ) {
    super(message);
    this.name = "EvidenceAnalysisParseError";
  }
}

/**
 * A source, numbered for this one prompt. The model is asked to reference
 * sources only by this index — never by re-typing a URL — so the real
 * `url`/`query`/`title`/`source` are always taken back from this array in
 * code afterward, never from anything the model echoed. This is the same
 * "don't trust the model to transcribe an identifier" principle the
 * Research Planner's id-repair pass is built on, applied here from the
 * start instead of as a repair.
 */
interface NumberedSource {
  index: number;
  result: SearchResult;
}

/** Keeps prompt/output length down (a deliberate latency lever for CPU-only local inference, same rationale as the Research Planner's field caps) without cutting off the part of a snippet most likely to carry the actual evidence. */
function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

const ObservationSchema = z.object({
  observation: z.string().min(3).max(300),
  // Optional fields may arrive as null OR be omitted entirely by the model;
  // normalize both to null so `EvidenceObservation` stays `string | null`.
  affected_group: z.string().min(2).max(120).nullish().transform((v) => v ?? null),
  activity: z.string().min(2).max(160).nullish().transform((v) => v ?? null),
  friction: z.string().min(2).max(160).nullish().transform((v) => v ?? null),
  workaround: z.string().min(2).max(160).nullish().transform((v) => v ?? null),
  existing_solution: z.string().min(2).max(160).nullish().transform((v) => v ?? null),
  unresolved_signal: z.string().min(2).max(160).nullish().transform((v) => v ?? null),
});

const EvidenceEntrySchema = z.object({
  source_index: z.number().int().positive(),
  stance: z.enum(EVIDENCE_STANCES),
  relevance: z.enum(EVIDENCE_RELEVANCE_LEVELS),
  evidence_summary: z.string().min(3).max(300),
  observations: z.array(ObservationSchema).max(4).default([]),
});

const AnalyzerOutputSchema = z.object({
  evidence: z.array(EvidenceEntrySchema).min(1),
});

const SYSTEM_PROMPT = `You are the Evidence Analyzer inside ProblemRadar. You receive one research investigation question and a numbered list of real web-search results already retrieved for it, and you classify each result's relationship to that question using ONLY the text given for that result — you never invent a fact, number, or detail that isn't present in the title/snippet below. You do not search the web, you do not rank, score, or decide whether any problem is real — only how each given source relates to the question and what factual observations it supports. Output ONLY the JSON object: no prose, no markdown fences, no <think> reasoning, no explanation.`;

function buildPrompt(hypothesis: ResearchHypothesis, sources: NumberedSource[], correction?: string | null): string {
  const sourceLines = sources
    .map(({ index, result }) => {
      const dateText = result.published_date ? result.published_date : "unknown";
      return `${index}. title: "${truncate(result.title, 160)}" | snippet: "${truncate(result.snippet, 300)}" | source: "${result.source}" | published: ${dateText}`;
    })
    .join("\n");

  return `Hypothesis (lens: "${hypothesis.lens}"):
"${hypothesis.hypothesis}"

Sources retrieved for this hypothesis — use ONLY the text below, nothing else:
${sourceLines}

For EVERY source above, return one entry with:
- "source_index": that source's number above (integer).
- "stance": "supports" if the source's own text corroborates the investigation question, "challenges" if it contradicts/undermines the assumption behind it, or "neutral" if it's related but doesn't clearly do either (including when there's too little in the snippet to tell). Stance describes the source's relationship to the question — evidence of an unexpected issue is still valuable and must not be forced to "supports".
- "relevance": "high" if the source is directly about this exact question, "medium" if related but not exact, "low" if only marginally related.
- "evidence_summary": one sentence, strictly paraphrasing or quoting what that source's own title/snippet says — never add a fact, place name, statistic, or claim that isn't in it.
- "observations" (0-4): structured factual observations this source directly supports. Each field must be explicitly present in the source's own text; use null for anything the source does not establish (do not infer cost, outcomes, delays, causation, workarounds, or solutions that aren't stated). For "affected_group" use the group exactly as the source names it — if the source names no group, return null rather than generalizing a place into its people ("in rural areas" does not license "rural residents"; "cities and suburbs" does not license "urban"). Prefer null over a plausible-sounding fill: an absent field is correct, an unsupported one invalidates this source's whole entry. Two fields are easy to overlook — actively scan for them: if the source names a concrete service, program, product, or initiative people already use, put it verbatim in "existing_solution"; if the source shows something still unaddressed, explicitly unresolved, or acknowledged as unsolved, put that in "unresolved_signal". Set either to null only when the source genuinely says nothing of the kind. Fields: "observation" (required, the supported fact), "affected_group", "activity", "friction", "workaround", "existing_solution", "unresolved_signal" (all nullable). If the source supports no useful observation, return an empty array.

Output ONLY this JSON shape, with exactly ${sources.length} entries — one per source index above, no duplicates, none missing:
{"evidence":[{"source_index":1,"stance":"supports","relevance":"high","evidence_summary":"...","observations":[{"observation":"...","affected_group":"...","activity":"...","friction":"...","workaround":null,"existing_solution":null,"unresolved_signal":null}]}]}${correction ? `

Your previous attempt was rejected by validation:
${correction}

Fix exactly that: reword the offending field to match the source's own words, or set it to null if the source never states it. Leave every other field as it was.` : ""}`;
}

/** Same Jaccard-style word-overlap technique used elsewhere in this pipeline (Research Planner's hypothesis-similarity check, Search Orchestrator's query-dedup check), applied here to catch a summary that doesn't actually derive from the source it claims to summarize. */
function normalizeWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3)
  );
}

/**
 * Deterministic groundedness guardrail: requires a meaningful share of the
 * summary's substantive (4+ letter) words to actually appear in the
 * source's own title+snippet text. Lenient enough to allow genuine
 * paraphrasing (it's a share of the *summary's* words, not a strict
 * substring or a high Jaccard score), strict enough to reject a summary
 * that's mostly outside content — i.e. a fabricated fact. A summary with
 * no substantive words at all (e.g. all stopwords) is never grounded.
 */
const GROUNDEDNESS_THRESHOLD = 0.3;

function isGrounded(evidenceSummary: string, sourceText: string): boolean {
  const summaryWords = normalizeWords(evidenceSummary);
  if (summaryWords.size === 0) return false;
  const sourceWords = normalizeWords(sourceText);
  let shared = 0;
  for (const word of summaryWords) {
    if (sourceWords.has(word)) shared += 1;
  }
  return shared / summaryWords.size >= GROUNDEDNESS_THRESHOLD;
}

/**
 * Minimal morphological folding so the same word isn't treated as a different
 * fact just because one side pluralized, tensed, or derived it
 * ("investments" vs "investment", "transportation" vs "transport"). Applied
 * iteratively so derived forms converge on a shared stem
 * ("educational" -> "education" -> "educ" = "education" -> "educ").
 * Deliberately rule-of-thumb only — no dictionary, no stemming library —
 * and guarded so it never strips a token below 4 characters. Applied to
 * *observation* field matching below; the pre-existing `evidence_summary`
 * check (`isGrounded`) is left exactly as it was.
 */
function stemToken(word: string): string {
  let current = word;
  for (let i = 0; i < 4; i++) {
    if (current.length <= 4) return current;
    let next: string | null = null;
    if (current.endsWith("ies") && current.length > 5) next = current.slice(0, -3) + "y";
    else if (current.endsWith("sses")) next = current.slice(0, -2);
    else if (current.endsWith("shes") || current.endsWith("ches")) next = current.slice(0, -2);
    else if (current.endsWith("ation") && current.length - 5 >= 4) next = current.slice(0, -5);
    else if (current.endsWith("al") && current.length - 2 >= 4) next = current.slice(0, -2);
    else if (current.endsWith("ing") && current.length - 3 >= 4) next = current.slice(0, -3);
    else if (current.endsWith("ed") && current.length - 2 >= 4) next = current.slice(0, -2);
    else if (current.endsWith("s") && !current.endsWith("ss") && !current.endsWith("us")) next = current.slice(0, -1);
    if (next === null || next === current) return current;
    current = next;
  }
  return current;
}

function stemWords(text: string): Set<string> {
  return new Set([...normalizeWords(text)].map(stemToken));
}

/**
 * Grounding check for a structured observation field: same overlap
 * threshold as `isGrounded`, but matches on inflection-folded tokens. A
 * field whose *concept* is absent from the source still scores 0 and is
 * still rejected — this only stops paraphrase-shaped rejections of a fact
 * the source does state.
 */
function isFieldGrounded(field: string, sourceText: string): boolean {
  const fieldWords = stemWords(field);
  if (fieldWords.size === 0) {
    // Every token was too short to be substantive ("DSL", "4G"), so the
    // overlap ratio is undefined. Fall back to a literal case-insensitive
    // match instead of rejecting outright — a short acronym the source
    // really does contain still grounds, one it never mentions still
    // doesn't.
    const normalize = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const fieldText = normalize(field);
    return fieldText.length > 0 && normalize(sourceText).includes(fieldText);
  }
  const sourceWords = stemWords(sourceText);
  let shared = 0;
  for (const word of fieldWords) {
    if (sourceWords.has(word)) shared += 1;
  }
  return shared / fieldWords.size >= GROUNDEDNESS_THRESHOLD;
}

/** Matches "<n> <unit>(s) ago" (SerpApi's common relative-date phrasing, e.g. "3 days ago", "2 weeks ago"). */
const RELATIVE_DATE_PATTERN = /^(\d+)\s+(day|week|month|year)s?\s+ago$/i;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_DAYS = 365;

/**
 * Deterministic recency classification from a SearchResult's own
 * `published_date` — plain date arithmetic, so it's computed in code
 * rather than left to the model to "assess". SerpApi dates come in two
 * shapes: an absolute date string (parseable by `Date.parse`) or a
 * relative one like "3 days ago" (handled explicitly, since
 * `Date.parse` can't). Anything else, or no date at all, is "unknown" —
 * never guessed as either recent or dated.
 */
export function computeRecency(publishedDate: string | null): EvidenceRecency {
  if (!publishedDate) return "unknown";
  const trimmed = publishedDate.trim();

  const relativeMatch = trimmed.match(RELATIVE_DATE_PATTERN);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const approxDays = unit === "day" ? amount : unit === "week" ? amount * 7 : unit === "month" ? amount * 30 : amount * 365;
    return approxDays <= RECENT_WINDOW_DAYS ? "recent" : "dated";
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return "unknown";
  const ageDays = (Date.now() - parsed) / MS_PER_DAY;
  if (ageDays < 0) return "unknown"; // a "future" date is a parsing artifact, not a real signal
  return ageDays <= RECENT_WINDOW_DAYS ? "recent" : "dated";
}

/** Quantifiers that make an observation stronger than partial evidence can support. */
const STRONG_QUANTIFIERS = /\b(all|every|everyone|always|most|majority|none|nobody|never|widespread)\b/i;

/** Markers that turn a statement into an explicit causal claim. */
const CAUSAL_MARKERS = ["cause", "causes", "caused", "because", "due to", "result in", "results in", "resulted in", "lead to", "leads to", "led to", "drives", "driven by", "contribute to", "contributes to", "contributed to"];

/** Demographic/group terms that must literally appear in the source. */
const POPULATION_TERMS = new Set([
  "rural", "urban", "elderly", "senior", "seniors", "veteran", "veterans", "farmer", "farmers",
  "student", "students", "children", "teacher", "teachers", "patient", "patients", "resident", "residents",
  "women", "disabled", "indigenous", "tribal", "small business", "small businesses", "small-business",
]);

function numbersIn(text: string): Set<string> {
  return new Set(text.match(/\d+(?:\.\d+)?/g) ?? []);
}

/**
 * Strict fact checks shared by the summary and every observation field:
 * no invented statistics, no stronger quantifiers, no unsupported
 * causation, no population the source doesn't name.
 */
function assertFactuallySupported(text: string, sourceText: string, what: string, raw: string): void {
  const sourceNumbers = numbersIn(sourceText);
  const unsupportedNumbers = [...numbersIn(text)].filter((number) => !sourceNumbers.has(number));
  if (unsupportedNumbers.length > 0) {
    throw new EvidenceAnalysisParseError(`${what} contains a statistic absent from its source: ${unsupportedNumbers.join(", ")}.`, raw);
  }
  if (STRONG_QUANTIFIERS.test(text) && !STRONG_QUANTIFIERS.test(sourceText)) {
    throw new EvidenceAnalysisParseError(`${what} makes a claim stronger than its source establishes.`, raw);
  }
  const lower = text.toLowerCase();
  if (CAUSAL_MARKERS.some((marker) => lower.includes(marker)) && !CAUSAL_MARKERS.some((marker) => sourceText.includes(marker))) {
    throw new EvidenceAnalysisParseError(`${what} asserts causation not stated in its source.`, raw);
  }
  const textWords = normalizeWords(text);
  const sourceStems = stemWords(sourceText);
  const unsupportedPopulation = [...textWords]
    .filter((word) => POPULATION_TERMS.has(word))
    .filter((word) => !sourceStems.has(stemToken(word)));
  if (unsupportedPopulation.length > 0) {
    throw new EvidenceAnalysisParseError(`${what} names a population not established by its source: ${unsupportedPopulation.join(", ")}.`, raw);
  }
}

/**
 * Deterministic sanity check beyond structural schema validation:
 *
 * - every source index from 1..sources.length must appear exactly once
 *   (no duplicates, none skipped), and
 * - every `evidence_summary` must actually ground in the source it's
 *   paired with.
 *
 * Both throw `EvidenceAnalysisParseError`, which the retry loop below
 * treats the same as a schema-validation failure — so a hypothesis whose
 * *summaries* are fabricated fails as a whole, exactly as it did before
 * observations existed.
 *
 * Structured observations are checked with the same strictness but
 * scoped per observation: an unsupported one is dropped and logged, so a
 * single invented field doesn't also throw away the other valid evidence
 * the same hypothesis produced. Nothing unsupported is ever surfaced
 * either way.
 */
function assertEvidenceIsSound(
  entries: z.infer<typeof AnalyzerOutputSchema>["evidence"],
  sources: NumberedSource[],
  raw: string
): void {
  const byIndex = new Map(sources.map((s) => [s.index, s.result]));
  const seenIndices = new Set<number>();

  for (const entry of entries) {
    if (!byIndex.has(entry.source_index)) {
      throw new EvidenceAnalysisParseError(
        `Evidence entry references source_index ${entry.source_index}, which wasn't one of the ${sources.length} sources given.`,
        raw
      );
    }
    if (seenIndices.has(entry.source_index)) {
      throw new EvidenceAnalysisParseError(
        `source_index ${entry.source_index} appears more than once — each source must get exactly one evidence entry.`,
        raw
      );
    }
    seenIndices.add(entry.source_index);

    const source = byIndex.get(entry.source_index)!;
    const sourceText = `${source.title} ${source.snippet}`;
    if (!isGrounded(entry.evidence_summary, sourceText)) {
      throw new EvidenceAnalysisParseError(
        `Evidence summary for source_index ${entry.source_index} ("${entry.evidence_summary}") doesn't ground in that source's own title/snippet — looks fabricated rather than extracted.`,
        raw
      );
    }
    assertFactuallySupported(entry.evidence_summary, sourceText, `Evidence summary for source_index ${entry.source_index}`, raw);

    // Observations are validated independently: an unsupported one is
    // rejected outright and never surfaced, but it does not also discard
    // the rest of this source's evidence or the hypothesis's other
    // sources. The pre-existing checks here — summary grounding and index
    // coverage — still fail the whole hypothesis exactly as before; only
    // the Phase 2 observation content is isolated this way.
    const keptObservations: typeof entry.observations = [];
    for (const observation of entry.observations) {
      const label = `Observation for source_index ${entry.source_index}`;
      try {
        if (!isFieldGrounded(observation.observation, sourceText)) {
          throw new EvidenceAnalysisParseError(`${label} ("${observation.observation}") doesn't ground in that source's own title/snippet.`, raw);
        }
        assertFactuallySupported(observation.observation, sourceText, label, raw);
        const optionalFields = [
          ["affected_group", observation.affected_group],
          ["activity", observation.activity],
          ["friction", observation.friction],
          ["workaround", observation.workaround],
          ["existing_solution", observation.existing_solution],
          ["unresolved_signal", observation.unresolved_signal],
        ] as const;
        for (const [field, value] of optionalFields) {
          if (value === null) continue;
          if (!isFieldGrounded(value, sourceText)) {
            throw new EvidenceAnalysisParseError(`${label} has a ${field} ("${value}") not supported by the source's own text.`, raw);
          }
          assertFactuallySupported(value, sourceText, `${label} ${field}`, raw);
        }
        keptObservations.push(observation);
      } catch (error) {
        console.warn(
          `[ProblemRadar/EvidenceAnalyzer] rejecting unsupported observation (source_index ${entry.source_index}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    entry.observations = keptObservations;
  }

  if (seenIndices.size !== sources.length) {
    const missing = sources.map((s) => s.index).filter((index) => !seenIndices.has(index));
    throw new EvidenceAnalysisParseError(
      `Missing evidence entries for source index(es): ${missing.join(", ")} (expected exactly ${sources.length}).`,
      raw
    );
  }
}

/** How many times to ask the model again for one hypothesis's evidence before giving up on it (never crashing the whole run — see `runEvidenceAnalyzer`). Same rationale as the other two LLM stages: `format: "json"` only guarantees syntactically valid JSON, and generation isn't deterministic, so asking again is usually enough. */
const MAX_ATTEMPTS = 2;

/**
 * Analyzes one hypothesis's already-retrieved sources. Never calls the
 * model when there are no sources to analyze — that's not a judgment
 * call, so it's handled deterministically as `status: "no_evidence"`.
 */
async function analyzeHypothesisEvidence(
  hypothesis: ResearchHypothesis,
  results: SearchResult[],
  getProvider: () => LLMProvider = getLLMProvider
): Promise<HypothesisEvidenceAnalysis> {
  const base = { hypothesis_id: hypothesis.id, lens: hypothesis.lens, hypothesis: hypothesis.hypothesis };

  if (results.length === 0) {
    console.log(`[ProblemRadar/EvidenceAnalyzer] hypothesis="${hypothesis.id}" — no retrieved sources, skipping LLM call`);
    return { ...base, status: "no_evidence", evidence: [], support_count: 0, challenge_count: 0, neutral_count: 0 };
  }

  const sources: NumberedSource[] = results.map((result, i) => ({ index: i + 1, result }));
  const provider = getProvider();

  // Validation feedback from the previous attempt, fed back into the next
  // prompt so a retry corrects the specific rejected field instead of
  // regenerating blindly. `withRetry` itself is unchanged — it already
  // surfaces the error through `onRetry`.
  let lastFailure: string | null = null;

  const entries = await withRetry(
    async (attemptNumber) => {
      const raw = await provider.generateJSON({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(hypothesis, sources, lastFailure),
        temperature: 0.1,
      });

      console.log(
        `[ProblemRadar/EvidenceAnalyzer] hypothesis="${hypothesis.id}" attempt ${attemptNumber}/${MAX_ATTEMPTS} — raw model output:\n${raw}`
      );

      const jsonText = extractJsonObject(raw);

      let parsedUnknown: unknown;
      try {
        parsedUnknown = JSON.parse(jsonText);
      } catch {
        throw new EvidenceAnalysisParseError(
          `The model (${provider.name}) did not return valid JSON for hypothesis "${hypothesis.id}" (attempt ${attemptNumber}/${MAX_ATTEMPTS}).`,
          raw
        );
      }

      const result = AnalyzerOutputSchema.safeParse(parsedUnknown);
      if (!result.success) {
        throw new EvidenceAnalysisParseError(
          `The model's JSON did not match the expected evidence structure for hypothesis "${hypothesis.id}": ${result.error.message}`,
          raw
        );
      }

      assertEvidenceIsSound(result.data.evidence, sources, raw);

      return result.data.evidence;
    },
    {
      maxAttempts: MAX_ATTEMPTS,
      // Validation failures retry so the model can act on the feedback
      // captured in `lastFailure`. Transient Ollama generation failures
      // (a request that timed out while the model was still loading, or a
      // `token repeat limit reached` degeneration from one sampling pass)
      // are also worth the second attempt `withRetry` already budgets:
      // they are per-call hiccups, not outcomes. Validation strictness is
      // untouched either way — a retried response still has to pass every
      // grounding check exactly as before.
      isRetryable: (error) =>
        error instanceof EvidenceAnalysisParseError || error instanceof LLMConnectionError,
      onRetry: (attemptNumber, error) => {
        const message = error instanceof Error ? error.message : String(error);
        lastFailure = message;
        console.warn(
          `[ProblemRadar/EvidenceAnalyzer] hypothesis="${hypothesis.id}" attempt ${attemptNumber}/${MAX_ATTEMPTS} failed validation (retrying — ${MAX_ATTEMPTS - attemptNumber} attempt(s) left): ${message}`
        );
      },
    }
  );

  const evidence: SourceEvidence[] = entries.map((entry) => {
    const source = sources.find((s) => s.index === entry.source_index)!.result;
    return {
      hypothesis_id: hypothesis.id,
      // Always the original SearchResult's own fields — never anything
      // the model produced — so every entry stays exactly traceable.
      url: source.url,
      query: source.query,
      title: source.title,
      source: source.source,
      stance: entry.stance as EvidenceStance,
      relevance: entry.relevance as EvidenceRelevance,
      recency: computeRecency(source.published_date),
      evidence_summary: entry.evidence_summary,
      observations: entry.observations.map((observation) => ({ ...observation, source_index: entry.source_index })),
    };
  });

  console.log(
    `[ProblemRadar/EvidenceAnalyzer] ✓ hypothesis="${hypothesis.id}" analyzed ${evidence.length} source(s): ` +
      `${evidence.filter((e) => e.stance === "supports").length} support, ` +
      `${evidence.filter((e) => e.stance === "challenges").length} challenge, ` +
      `${evidence.filter((e) => e.stance === "neutral").length} neutral`
  );

  return {
    ...base,
    status: "analyzed",
    evidence,
    support_count: evidence.filter((e) => e.stance === "supports").length,
    challenge_count: evidence.filter((e) => e.stance === "challenges").length,
    neutral_count: evidence.filter((e) => e.stance === "neutral").length,
  };
}

/**
 * Stage 4 of the ProblemRadar research pipeline: the Evidence Analyzer.
 * Takes an already-validated `ResearchPlan` (stage 2) and its matching
 * `SearchRun` (stage 3's output — this never re-runs search or calls
 * SerpApi) and, hypothesis by hypothesis, uses the configured LLM only to
 * *interpret* the already-retrieved text: classify each source's stance,
 * judge its relevance, extract a grounded evidence summary, and (for useful
 * sources) structured evidence-backed observations: who is affected, what
 * they are doing, what friction occurs, what workaround or existing solution
 * is mentioned, and what remains unresolved. Recency
 * is computed deterministically, not asked of the model (see
 * `computeRecency`). No web search, no scoring/ranking of hypotheses, no
 * problem generation — this stage ends at structured, source-traceable
 * evidence, ready for a future stage to build on.
 *
 * Each hypothesis is analyzed independently and its own failure (a
 * connection error, or exhausting `MAX_ATTEMPTS` of invalid/unsound
 * model output) is caught here and recorded as `status: "failed"` with
 * an `error` message — it never aborts the rest of the run. This is the
 * same "one bad unit of work never aborts the whole run" pattern the
 * Search Orchestrator uses for individual queries.
 */
export async function runEvidenceAnalyzer(
  plan: ResearchPlan,
  run: SearchRun,
  getProvider: () => LLMProvider = getLLMProvider
): Promise<EvidenceAnalysisRun> {
  const startedAt = new Date();

  const resultsByHypothesis = new Map<string, SearchResult[]>();
  for (const result of run.results) {
    const existing = resultsByHypothesis.get(result.hypothesis_id);
    if (existing) {
      existing.push(result);
    } else {
      resultsByHypothesis.set(result.hypothesis_id, [result]);
    }
  }

  console.log(
    `[ProblemRadar/EvidenceAnalyzer] starting run: ${plan.hypotheses.length} hypothesis(es), ${run.results.length} retrieved source(s) total`
  );

  const hypotheses: HypothesisEvidenceAnalysis[] = [];

  for (const hypothesis of plan.hypotheses) {
    const results = resultsByHypothesis.get(hypothesis.id) ?? [];
    try {
      hypotheses.push(await analyzeHypothesisEvidence(hypothesis, results, getProvider));
    } catch (error) {
      // Catches anything analyzeHypothesisEvidence didn't already turn
      // into a controlled outcome — an LLMConnectionError, or the final
      // EvidenceAnalysisParseError once MAX_ATTEMPTS is exhausted — so
      // one hypothesis's failure never brings down the rest of the run.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ProblemRadar/EvidenceAnalyzer] ✗ hypothesis="${hypothesis.id}" failed: ${message}`);
      hypotheses.push({
        hypothesis_id: hypothesis.id,
        lens: hypothesis.lens,
        hypothesis: hypothesis.hypothesis,
        status: "failed",
        error: message,
        evidence: [],
        support_count: 0,
        challenge_count: 0,
        neutral_count: 0,
      });
    }
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();

  const analyzedCount = hypotheses.filter((h) => h.status === "analyzed").length;
  const noEvidenceCount = hypotheses.filter((h) => h.status === "no_evidence").length;
  const failedCount = hypotheses.filter((h) => h.status === "failed").length;

  console.log(
    `[ProblemRadar/EvidenceAnalyzer] done in ${durationMs}ms — ${analyzedCount} analyzed, ${noEvidenceCount} with no evidence, ${failedCount} failed`
  );

  return {
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: durationMs,
    hypotheses,
  };
}
