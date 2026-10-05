import { z } from "zod";

import type {
  CandidateProblem,
  EvidenceAnalysisRun,
  EvidenceObservation,
  HypothesisEvidenceAnalysis,
  ProblemEvidenceReference,
  ProblemGenerationResult,
  ResearchPlan,
  SourceEvidence,
} from "@/types";
import { extractJsonObject } from "./json-utils";
import { getLLMProvider, type LLMProvider } from "./index";
import { withRetry } from "./with-retry";

export class ProblemGenerationParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = "ProblemGenerationParseError";
  }
}

const ObservationSchema = z.object({
  claim: z.string().min(3).max(240),
  evidence_indices: z.array(z.number().int().positive()).min(1).max(12),
});

const GeneratedProblemSchema = z.object({
  problem_statement: z.string().min(12).max(240),
  affected_population: z.string().min(3).max(160),
  /** The concrete activity/workflow that is difficult or fails — must be grounded in the cited evidence. */
  affected_activity: z.string().min(3).max(160),
  context: z.string().min(3).max(200),
  mechanism: z.string().min(3).max(200),
  observed_impact: z.string().min(3).max(200),
  observations: z.array(ObservationSchema).min(1).max(6),
  evidence_indices: z.array(z.number().int().positive()).min(1).max(12),
});

const OutputSchema = z.object({ problems: z.array(GeneratedProblemSchema).max(3) });

interface EvidenceGroup {
  /** Position in this prompt's citation space (1-based): citable supporting groups first, challenging groups after. */
  index: number;
  /** Which bucket this group belongs to; only "supporting" groups may be cited. */
  kind: "supporting" | "challenging";
  evidence: SourceEvidence[];
  /**
   * The validated structured observations (Phase 2) carried by these
   * sources. Candidates are derived from these — never from the research
   * hypothesis — so a supporting group without any of them is not citable.
   */
  observations: EvidenceObservation[];
}

interface PreparedEvidence {
  /** Every supporting group regardless of observations (drives the "no_evidence" gate and the counts). */
  supporting: EvidenceGroup[];
  /** Supporting groups carrying at least one validated observation — the citable space, densely renumbered 1..k. */
  citable: EvidenceGroup[];
  challenging: EvidenceGroup[];
  supportWeight: number;
  challengeWeight: number;
  supportCount: number;
  challengeCount: number;
}

function weight(evidence: SourceEvidence): number {
  return evidence.relevance === "high" ? 2 : evidence.relevance === "medium" ? 1 : 0;
}

/** Validated observations carried by a group's sources, with repeats from duplicate retrievals removed. */
function collectObservations(evidence: SourceEvidence[]): EvidenceObservation[] {
  const seen = new Set<string>();
  const observations: EvidenceObservation[] = [];
  for (const item of evidence) {
    for (const observation of item.observations ?? []) {
      const key = observation.observation.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      observations.push(observation);
    }
  }
  return observations;
}

function groupEvidence(items: SourceEvidence[], kind: EvidenceGroup["kind"], offset: number): EvidenceGroup[] {
  const groups = new Map<string, SourceEvidence[]>();
  for (const item of items) {
    const key = `${item.url.trim().toLowerCase()}\n${item.query.trim().toLowerCase()}\n${item.evidence_summary.trim().toLowerCase()}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].map((evidence, index) => ({ index: offset + index + 1, kind, evidence, observations: collectObservations(evidence) }));
}

function prepareEvidence(analysis: HypothesisEvidenceAnalysis, hypothesisId: string): PreparedEvidence {
  const supportingItems = analysis.evidence.filter(
    (item) => item.hypothesis_id === hypothesisId && item.stance === "supports" && (item.relevance === "high" || item.relevance === "medium")
  );
  const challengingItems = analysis.evidence.filter(
    (item) => item.hypothesis_id === hypothesisId && item.stance === "challenges" && (item.relevance === "high" || item.relevance === "medium")
  );
  const supportingGroups = groupEvidence(supportingItems, "supporting", 0);
  // Observation-first citation space: only supporting groups that carry at
  // least one validated observation are citable, and they are renumbered
  // densely (1..k) so every number shown to the model is one it may cite.
  // Challenging groups continue after them (they still may NOT be cited).
  const citable = groupEvidence(
    supportingItems.filter((item) => (item.observations?.length ?? 0) > 0),
    "supporting",
    0
  );
  const challenging = groupEvidence(challengingItems, "challenging", citable.length);
  return {
    supporting: supportingGroups,
    citable,
    challenging,
    supportWeight: supportingItems.reduce((total, item) => total + weight(item), 0),
    challengeWeight: challengingItems.reduce((total, item) => total + weight(item), 0),
    supportCount: supportingItems.length,
    challengeCount: challengingItems.length,
  };
}

/** Keeps prompt length bounded (same latency rationale as the other stages' field caps) — Ollama runs qwen3:8b on a 4096-token context. */
function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

/** Structured observation fields, in the order they are shown. Absent fields were not established by the source. */
const OBSERVATION_FIELDS = [
  "affected_group",
  "activity",
  "friction",
  "workaround",
  "existing_solution",
  "unresolved_signal",
] as const;

/** How many validated observations per group fit in the prompt budget ("foreign" = related groups borrowed from other hypotheses). */
const MAX_OBSERVATIONS_SHOWN = { supporting: 3, foreign: 2, challenging: 2 } as const;

/**
 * One validated observation as the model sees it: the observed fact plus
 * whichever structured fields its source actually established (null fields
 * are omitted — an absent field means "not established", not "free space").
 */
function formatObservation(observation: EvidenceObservation): string {
  const text = `"${truncate(observation.observation, 200)}"`;
  const fields = OBSERVATION_FIELDS.map((field) =>
    observation[field] ? `${field.replace("_", " ")}: "${truncate(observation[field]!, 70)}"` : null
  ).filter((line): line is string => line !== null);
  return fields.length > 0 ? `${text} — ${fields.join(" | ")}` : text;
}

function formatGroup(group: EvidenceGroup, bucket: keyof typeof MAX_OBSERVATIONS_SHOWN): string {
  const evidenceText = group.evidence
    .map((item) => `"${truncate(item.evidence_summary, 300)}" (${truncate(item.title, 120)}; ${item.source})`)
    .join(" / ");
  const shown = group.observations.slice(0, MAX_OBSERVATIONS_SHOWN[bucket]);
  const lines = shown.map((observation) => `   validated observation: ${formatObservation(observation)}`);
  const omitted = group.observations.length - shown.length;
  if (omitted > 0) lines.push(`   (${omitted} further validated observation(s) not shown)`);
  if (lines.length === 0) lines.push("   (no validated observations)");
  return `${group.index}. evidence: ${evidenceText}\n${lines.join("\n")}`;
}

/**
 * A group's validated observations as text, for claim-traceability checks:
 * the observed fact plus every field its source established (all of it was
 * validated against that source by the Evidence Analyzer).
 */
function validatedObservationText(group: EvidenceGroup): string {
  return group.observations
    .map((observation) =>
      [observation.observation, observation.affected_group, observation.activity, observation.friction, observation.workaround, observation.existing_solution, observation.unresolved_signal]
        .filter((part): part is string => Boolean(part))
        .join(" ")
    )
    .join(" ");
}

function buildPrompt(
  hypothesis: { hypothesis: string },
  citable: EvidenceGroup[],
  foreign: EvidenceGroup[],
  challenging: EvidenceGroup[]
): string {
  const supportText = citable.length ? citable.map((group) => formatGroup(group, "supporting")).join("\n") : "None supplied.";
  const foreignText = foreign.length ? foreign.map((group) => formatGroup(group, "foreign")).join("\n") : "None supplied.";
  const challengeText = challenging.length
    ? challenging.map((group) => formatGroup(group, "challenging")).join("\n")
    : "None supplied.";

  return `Research hypothesis (context only — it is NOT evidence and never establishes that a problem exists):
"${hypothesis.hypothesis}"

Validated observations from supporting sources — the ONLY basis for a candidate problem. Every observation below was already checked against its own source, and every claim you make must trace back to one of them and to its cited evidence — never to the hypothesis. Cite only these numbered items:
${supportText}

Related validated observations from OTHER hypotheses — the same underlying situation seen through a different research direction (numbering continues from the list above). Cite them together with your own observations ONLY when they genuinely describe the same affected activity and friction; if they describe a different situation, ignore them entirely:
${foreignText}

Relevant challenging evidence and its observations (numbering continues from the lists above; weigh them before accepting a problem; they may NOT be cited):
${challengeText}

Build each candidate in three steps, all internal — reason through them, but output only the final JSON:
1) PATTERN: group the SUPPORTING observations from either list above that are genuinely related — they must describe the same affected activity and friction, not merely share a domain, place, or topic. A pattern may span your own observations and related ones from another hypothesis when they describe the same underlying situation; unrelated observations must never be forced into one pattern.
2) ACTIVITY AND UNMET NEED: for each pattern, name the specific affected activity/job the observations show someone actually trying to perform, plus the observable friction, failure, or unmet need. A field absent from an observation was not established by its source — never fill it in from plausibility.
3) CANDIDATE: write one problem from that pattern alone. If no pattern establishes a specific recurring situation, return no problem rather than a broad topic ("rural healthcare is a problem") or a restatement of the hypothesis.

Return zero to three distinct problems — but default to ZERO: a hypothesis is only a research direction, so never emit a candidate just because this hypothesis was investigated and never assume one hypothesis deserves exactly one problem. Emit a candidate only when the validated observations above (not the hypothesis) establish a specific recurring situation; if they do not, return an empty problems list. Each problem must cite only supporting item numbers from the lists above. Before writing the problem fields, list the small set of atomic observations you can actually support (each with its own evidence_indices), and make every other field a concise synthesis of those observations: every claim must remain supported by both the cited evidence and the validated observations behind it. Do not add unsupported facts, statistics, causes, populations, comparisons, impacts, workarounds, existing-solution claims, or failures, and do not strengthen what the evidence establishes (e.g. do not turn "some" into "all", or a need for improvement into an existing solution failing). New structured observations must also stay within the evidence: e.g. if the evidence says compliance requirements make business growth harder, you may record that as an observation, but you may NOT add observations about specific approval delays, penalties, or workflows the evidence does not state. The affected_activity must name the real activity/workflow a person or organization is trying to perform that is difficult or fails; if the observations only establish a broad condition without a specific supported activity, keep the candidate broad or omit it. Neutral evidence is excluded. Do not create duplicate phrasings of one underlying problem; keep the clearest one and cite all relevant support. Relevant contrary evidence may require returning no problem. Return only this JSON shape:\n{"problems":[{"observations":[{"claim":"...","evidence_indices":[1]}],"problem_statement":"...","affected_population":"...","affected_activity":"...","context":"...","mechanism":"...","observed_impact":"...","evidence_indices":[1]}]}`;
}

const GROUNDING_STOP_WORDS = new Set([
  "a", "an", "the", "are", "is", "was", "were", "be", "been", "being", "to", "for", "of", "and", "in", "on", "at", "by", "as", "it", "its", "or", "via", "during", "from", "with", "without",
  "about", "above", "after", "again", "also", "among", "because", "been", "being", "below", "between", "both", "could", "does", "each", "from", "have", "into", "more", "most", "only", "other", "over", "same", "some", "such", "than", "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "under", "using", "very", "were", "what", "when", "where", "which", "while", "with", "within", "would", "your", "rural", "urban", "area", "areas", "community", "communities", "people", "residents", "individuals", "group", "groups", "service", "services", "problem", "problems", "issue", "issues", "need", "needs", "better", "improve", "improvement", "improvements", "current", "currently", "may", "might", "can", "often", "reported", "reportedly", "according", "evidence", "source", "sources", "shows", "show", "indicates", "indicated", "suggests", "suggested", "states", "state", "says", "said", "finding", "findings", "described", "describe", "identified", "identify", "observed", "observation", "observations", "noted", "notes", "appears", "appear", "seems", "seem", "claim", "claims", "candidate", "specific", "concrete", "directly", "safely", "explicitly", "supported", "supporting", "support", "cited", "cites", "based", "field", "fields", "population", "context", "mechanism", "impact", "statement",
]);
const NEGATION_OR_FAILURE = new Set(["not", "no", "never", "without", "lack", "lacks", "lacked", "lacking", "fail", "fails", "failed", "failure", "failures", "unable", "inadequate", "insufficient", "unavailable", "ineffective", "inefficient", "poor", "worse", "unmet", "shortage", "shortages", "deficit", "gap"]);

function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 5) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 6) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 5) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 4) return word.slice(0, -1);
  return word;
}

/**
 * Stop words for semantic grounding. Unlike the deduplication signature,
 * this keeps place/population/generic nouns (rural, urban, residents,
 * service, need, ...) as content words — they carry meaning that must be
 * checkable, otherwise population fields like "Rural residents" would
 * reduce to zero verifiable words.
 */
const GROUNDING_ENCODING_STOP_WORDS = new Set(
  [...GROUNDING_STOP_WORDS].filter(
    (word) =>
      ![
        "rural", "urban", "area", "areas", "people", "residents", "individuals", "group", "groups",
        "community", "communities", "service", "services", "problem", "problems", "issue", "issues",
        "need", "needs", "better", "improve", "improvement", "improvements", "current", "currently",
        "population", "field", "fields", "context", "mechanism", "impact", "statement", "candidate",
      ].includes(word)
  )
);

function groundingContentWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/-/g, " ").split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 2 && !GROUNDING_ENCODING_STOP_WORDS.has(word))
      .map((word) => stem(word.replace(/%$/, "")))
  );
}

function normalizedWords(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/-/g, " ").split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !GROUNDING_STOP_WORDS.has(word))
    .map((word) => stem(word.replace(/%$/, ""))));
}

/**
 * Groups of words that reasonably paraphrase one another. A field word is
 * considered supported when it (or a same-group word) stem-matches a word
 * in the cited evidence. This lets natural paraphrases through while still
 * flagging genuinely new content words.
 */
const PARAPHRASE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["significant", "substantial", "considerable", "major", "sized", "portion", "share", "fraction", "percent", "percentage", "widespread", "common"],
  ["adequate", "sufficient", "satisfactory", "reliable", "consistent", "dependable", "stable"],
  ["access", "coverage", "service", "connectivity", "connection", "broadband", "internet", "wifi", "network", "availability", "available", "online"],
  ["disconnect", "disconnecte", "interrupt", "interruption", "outage", "unstable", "unreliable", "disrupt", "drop", "dropp", "lose", "lost"],
  ["lack", "missing", "limited", "insufficient", "scarce", "rare", "shortage", "deficit", "unmet"],
  // Workforce/staffing: "staffing shortages", "recruiting/retaining difficulty", "medical professionals"
  ["staffing", "staff", "workforce", "worker", "recruit", "retain", "maintain", "adequate", "level", "professional", "clinician"],
  // Medical/healthcare vocabulary
  ["healthcare", "medical", "health", "physician", "nurse", "doctor", "provider", "professional", "service", "care", "worker"],
  // Facility vocabulary
  ["facility", "clinic", "hospital", "center", "site", "practice", "provider"],
  // Documented hardship wording
  ["challenge", "difficulty", "difficult", "barrier", "struggle", "shortage", "deficit", "significant", "substantial", "major", "limited", "lack", "insufficient", "inadequate"],
  // Information/awareness wording
  ["information", "verified", "verify", "aware", "awareness", "find", "locate", "access", "available", "availability", "opportunity", "opportunities", "resource", "resources", "program", "programs"],
];

/** Markers that turn evidence into an explicit causal claim. A candidate may only use them if the cited evidence uses one. */
const CAUSAL_MARKERS = ["cause", "causes", "caused", "because", "due to", "result in", "results in", "resulted in", "lead to", "leads to", "led to", "drives", "driven by", "contribute to", "contributes to", "contributed to"];

/** Demographic/geographic terms that, when present in a field, must be present in the evidence itself — a paraphrase must not swap the population. */
const POPULATION_TERMS = new Set([
  "rural", "urban", "suburban", "metro", "metropolitan", "elderly", "senior", "seniors", "veteran", "veterans",
  "farmer", "farmers", "women", "child", "children", "pediatric", "immigrant", "immigrants", "indigenous", "tribal",
  "black", "hispanic", "latino", "latina", "asian", "disabled", "disability", "teacher", "teachers", "student", "students",
]);

/** Quantifiers that make a claim strictly stronger than partial evidence ("some", "many", "a few") can support. */
const STRONG_QUANTIFIERS = /\b(all|every|everyone|everybody|always|each|nobody|no one|none|never|universally|most|majority|widespread)\b/i;

function numbersIn(text: string): Set<string> {
  return new Set(text.match(/\d+(?:\.\d+)?/g) ?? []);
}

/** Shared word-overlap scoring (with the PARAPHRASE_GROUPS escape hatch) used by every grounding check below. */
function overlapWith(claimWords: Set<string>, sourceWords: Set<string>): { supported: number; unsupported: string[] } {
  let supported = 0;
  const unsupported: string[] = [];
  for (const word of claimWords) {
    if (sourceWords.has(word)) {
      supported += 1;
      continue;
    }
    const group = PARAPHRASE_GROUPS.find((candidate) => candidate.includes(word));
    if (group && group.some((variant) => sourceWords.has(variant))) {
      supported += 1;
      continue;
    }
    unsupported.push(word);
  }
  return { supported, unsupported };
}

function assertGrounded(
  problem: z.infer<typeof GeneratedProblemSchema>,
  evidence: SourceEvidence[],
  raw: string,
  hypothesisText?: string,
  observationItems: Array<{ claim: string; items: SourceEvidence[]; validated: string[] }> = []
): void {
  const evidenceText = evidence.map((item) => item.evidence_summary).join(" ").toLowerCase();
  const evidenceWords = groundingContentWords(evidenceText);
  // Structured claims are the source of truth: final fields may reasonably
  // synthesize across them, so their semantic support is checked against
  // the evidence AND the generated claims, while each individual claim
  // must independently ground in its own cited items.
  const claimWords = groundingContentWords(observationItems.map((o) => o.claim).join(" "));
  const supportedWords = new Set<string>([...evidenceWords, ...claimWords]);
  const fields = [
    ["problem_statement", problem.problem_statement],
    ["affected_population", problem.affected_population],
    ["affected_activity", problem.affected_activity],
    ["context", problem.context],
    ["mechanism", problem.mechanism],
    ["observed_impact", problem.observed_impact],
  ] as const;

  // A problem statement that is effectively the research hypothesis itself
  // is a restatement, not a discovered problem.
  if (hypothesisText) {
    const statementWords = groundingContentWords(problem.problem_statement);
    const hypothesisWords = groundingContentWords(hypothesisText);
    let shared = 0;
    for (const word of statementWords) if (hypothesisWords.has(word)) shared += 1;
    const union = statementWords.size + hypothesisWords.size - shared;
    // Near-verbatim copy of the hypothesis (Jaccard >= 0.9) is a restatement,
    // not a discovered problem. Genuine paraphrases share only part of the
    // vocabulary and stay below this bar.
    if (union > 0 && shared / union >= 0.9) {
      throw new ProblemGenerationParseError("problem_statement restates the research hypothesis instead of a discovered problem.", raw);
    }
  }

  for (const [field, value] of fields) {
    const fieldWords = groundingContentWords(value);
    if (fieldWords.size === 0) {
      throw new ProblemGenerationParseError(`${field} contains no verifiable content from its cited evidence.`, raw);
    }
    for (let pass = 0; pass < 2; pass += 1) {
      const sourceWords = pass === 0 ? evidenceWords : supportedWords;
      // Strict fact checks must hold against the cited evidence itself.
      if (pass === 0) {
        const evidenceNumbers = numbersIn(evidenceText);
        const unsupportedNumbers = [...numbersIn(value.toLowerCase())].filter((number) => !evidenceNumbers.has(number));
        if (unsupportedNumbers.length > 0) {
          throw new ProblemGenerationParseError(`${field} contains a statistic absent from its cited evidence: ${unsupportedNumbers.join(", ")}.`, raw);
        }
        const unsupportedPopulation = [...fieldWords].filter((word) => POPULATION_TERMS.has(word) && !evidenceWords.has(word));
        if (unsupportedPopulation.length > 0) {
          throw new ProblemGenerationParseError(`${field} names a population not established by its cited evidence: ${unsupportedPopulation.join(", ")}.`, raw);
        }
        if (STRONG_QUANTIFIERS.test(value) && !STRONG_QUANTIFIERS.test(evidenceText)) {
          throw new ProblemGenerationParseError(`${field} makes a claim stronger than the cited evidence establishes.`, raw);
        }
        const lower0 = value.toLowerCase();
        const hasNegation = lower0.split(/[^a-z]+/).some((word) => NEGATION_OR_FAILURE.has(word));
        const evidenceHasNegation = evidenceText.split(/[^a-z]+/).some((word) => NEGATION_OR_FAILURE.has(word));
        if (hasNegation && !evidenceHasNegation) {
          throw new ProblemGenerationParseError(`${field} asserts a failure or negation not stated in the evidence.`, raw);
        }
        if (CAUSAL_MARKERS.some((marker) => lower0.includes(marker)) && !CAUSAL_MARKERS.some((marker) => evidenceText.includes(marker))) {
          throw new ProblemGenerationParseError(`${field} asserts causation not stated in the evidence.`, raw);
        }
      }
      const { supported, unsupported } = overlapWith(fieldWords, sourceWords);
      if (supported === 0 && pass === 1) {
        throw new ProblemGenerationParseError(`${field} is not semantically supported by its cited evidence.`, raw);
      }
      const supportedFraction = supported / fieldWords.size;
      const unsupportedBudget = Math.max(3, Math.floor(fieldWords.size / 2) + 1);
      if (pass === 1 && (supportedFraction < 1 / 3 || unsupported.length > unsupportedBudget)) {
        throw new ProblemGenerationParseError(`${field} contains unsupported claims: ${unsupported.join(", ")}.`, raw);
      }
    }
  }

  // Each structured observation must independently ground in its own cited
  // items AND stay traceable to the validated Phase 2 observations behind
  // them — a claim the model invented that happens to paraphrase the raw
  // evidence summaries but matches no validated observation is still not a
  // pattern derived from observations, so it is rejected.
  for (const observation of observationItems) {
    const claimText = observation.claim.toLowerCase();
    const itemText = observation.items.map((item) => item.evidence_summary).join(" ").toLowerCase();
    const itemWords = groundingContentWords(itemText);
    const clampNumbers = numbersIn(itemText);
    const unsupportedNumbers = [...numbersIn(claimText)].filter((number) => !clampNumbers.has(number));
    if (unsupportedNumbers.length > 0) {
      throw new ProblemGenerationParseError(`observation contains a statistic absent from its cited evidence: ${unsupportedNumbers.join(", ")}.`, raw);
    }
    const lower = claimText;
    const hasNegation = lower.split(/[^a-z]+/).some((word) => NEGATION_OR_FAILURE.has(word));
    const sourceHasNegation = itemText.split(/[^a-z]+/).some((word) => NEGATION_OR_FAILURE.has(word));
    if (hasNegation && !sourceHasNegation) {
      throw new ProblemGenerationParseError(`observation asserts a failure or negation not stated in its cited evidence.`, raw);
    }
    if (STRONG_QUANTIFIERS.test(claimText) && !STRONG_QUANTIFIERS.test(itemText)) {
      throw new ProblemGenerationParseError(`observation makes a claim stronger than its cited evidence establishes.`, raw);
    }
    if (CAUSAL_MARKERS.some((marker) => lower.includes(marker)) && !CAUSAL_MARKERS.some((marker) => itemText.includes(marker))) {
      throw new ProblemGenerationParseError(`observation asserts causation not stated in its cited evidence.`, raw);
    }
    const claimWords = groundingContentWords(observation.claim);
    if (claimWords.size === 0) {
      throw new ProblemGenerationParseError(`observation contains no verifiable content from its cited evidence.`, raw);
    }
    const evidenceOverlap = overlapWith(claimWords, itemWords);
    if (evidenceOverlap.supported === 0) {
      throw new ProblemGenerationParseError(`observation is not semantically supported by its cited evidence.`, raw);
    }
    const supportedFraction = evidenceOverlap.supported / claimWords.size;
    const unsupportedBudget = Math.max(2, Math.floor(claimWords.size / 2) + 1);
    if (supportedFraction < 1 / 3 || evidenceOverlap.unsupported.length > unsupportedBudget) {
      throw new ProblemGenerationParseError(`observation contains unsupported claims: ${evidenceOverlap.unsupported.join(", ")}.`, raw);
    }

    // Traceability: the claim must also be carried by the validated
    // observations its cited evidence produced (same thresholds as above,
    // so this only adds a requirement — it never relaxes one).
    const validatedWords = groundingContentWords(observation.validated.join(" "));
    if (validatedWords.size === 0) {
      throw new ProblemGenerationParseError(`observation claim cites evidence that carries no validated observation to trace back to.`, raw);
    }
    const traceOverlap = overlapWith(claimWords, validatedWords);
    if (traceOverlap.supported === 0) {
      throw new ProblemGenerationParseError(`observation claim is not traceable to any validated observation behind its cited evidence.`, raw);
    }
    const traceFraction = traceOverlap.supported / claimWords.size;
    if (traceFraction < 1 / 3 || traceOverlap.unsupported.length > unsupportedBudget) {
      throw new ProblemGenerationParseError(`observation claim is not traceable to the validated observations behind its cited evidence: ${traceOverlap.unsupported.join(", ")}.`, raw);
    }
  }
}

/**
 * A group's validated observations reduced to meaning-bearing concept keys:
 * each normalized word plus a `concept:<i>` key for every PARAPHRASE_GROUPS
 * group it belongs to. Generic place words ("rural") are dropped by
 * `normalizedWords`, so sharing only a place never counts as relatedness.
 */
function observationConceptKeys(group: EvidenceGroup): Set<string> {
  const text = validatedObservationText(group);
  const keys = new Set<string>();
  for (const word of normalizedWords(text)) {
    keys.add(word);
    for (const [groupIndex, words] of PARAPHRASE_GROUPS.entries()) {
      if (words.includes(word)) keys.add(`concept:${groupIndex}`);
    }
  }
  return keys;
}

/** Stable identity of a source's content, for "this exact material is already shown" checks. */
function sourceIdentity(item: SourceEvidence): string {
  return `${item.url.trim().toLowerCase()}\n${item.evidence_summary.trim().toLowerCase()}`;
}

/** How many related observation groups from other hypotheses may be offered to one call — qwen3:8b runs on a 4096-token context. */
const MAX_FOREIGN_GROUPS = 2;

/**
 * Cross-hypothesis pattern material: other hypotheses' citable groups whose
 * validated observations share at least one meaning-bearing word or
 * PARAPHRASE_GROUPS concept with this hypothesis's own citable observations
 * (the same relatedness rule `assertPatternIsCoherent` enforces, so anything
 * offered here can pass validation, and anything unrelated is never even
 * shown). Sources whose content the host already displays are skipped, and
 * the result is deterministic: strongest overlap first, then hypothesis id,
 * then group index — the same run always offers the same set.
 */
function selectRelatedForeignGroups(
  prepared: PreparedEvidence,
  preparedByHypothesis: Map<string, PreparedEvidence>,
  hostHypothesisId: string
): EvidenceGroup[] {
  if (prepared.citable.length === 0) return [];
  const hostKeys = new Set<string>();
  for (const group of prepared.citable) {
    for (const key of observationConceptKeys(group)) hostKeys.add(key);
  }
  const shownSources = new Set<string>();
  for (const group of [...prepared.citable, ...prepared.challenging]) {
    for (const item of group.evidence) shownSources.add(sourceIdentity(item));
  }
  const scored: Array<{ group: EvidenceGroup; shared: number; hypothesisId: string }> = [];
  for (const [hypothesisId, other] of preparedByHypothesis) {
    if (hypothesisId === hostHypothesisId) continue;
    for (const group of other.citable) {
      if (group.evidence.some((item) => shownSources.has(sourceIdentity(item)))) continue;
      const keys = observationConceptKeys(group);
      let shared = 0;
      for (const key of keys) if (hostKeys.has(key)) shared += 1;
      if (shared > 0) scored.push({ group, shared, hypothesisId });
    }
  }
  scored.sort((a, b) => b.shared - a.shared || a.hypothesisId.localeCompare(b.hypothesisId) || a.group.index - b.group.index);
  return scored.slice(0, MAX_FOREIGN_GROUPS).map((entry) => entry.group);
}

/**
 * Pattern coherence: a candidate citing more than one evidence item is a
 * *pattern* over those items' validated observations, so they must actually
 * relate to one another — sharing at least one meaning-bearing word or one
 * PARAPHRASE_GROUPS concept. Generic overlap on place words alone ("rural")
 * doesn't count (`normalizedWords` drops them). This is what stops
 * unrelated observations from being forced into one candidate (whether they
 * came from this hypothesis or were borrowed from another), while the
 * shared concept groups keep genuinely related observations that phrase
 * things differently (e.g. "recruiting workers" vs "staffing levels")
 * together.
 */
function assertPatternIsCoherent(indices: number[], groupsByIndex: Map<number, EvidenceGroup>, raw: string): void {
  const unique = [...new Set(indices)];
  if (unique.length < 2) return;

  const conceptKeys = unique.map((index) => observationConceptKeys(groupsByIndex.get(index)!));

  for (let i = 0; i < conceptKeys.length; i++) {
    const others = new Set<string>();
    for (let j = 0; j < conceptKeys.length; j++) {
      if (j === i) continue;
      for (const key of conceptKeys[j]) others.add(key);
    }
    const shared = [...conceptKeys[i]].filter((key) => others.has(key));
    if (shared.length === 0) {
      throw new ProblemGenerationParseError(
        `Candidate combines evidence indices ${unique.join(", ")} whose validated observations share no content — unrelated observations must not be forced together.`,
        raw
      );
    }
  }
}

/**
 * Resolves the cited citation-space indices to stable references. Each item
 * resolves through the origin map built from the full analysis, so a group
 * borrowed from another hypothesis still yields that hypothesis's own
 * `hypothesis_id` and its position in that hypothesis's evidence array —
 * provenance never points at the wrong hypothesis.
 */
function refsForIndices(
  indices: number[],
  supporting: EvidenceGroup[],
  evidenceIdByItem: Map<SourceEvidence, { hypothesis_id: string; evidence_id: string }>,
  raw: string
): ProblemEvidenceReference[] {
  const byIndex = new Map(supporting.map((group) => [group.index, group]));
  const seen = new Set<number>();
  const refs: ProblemEvidenceReference[] = [];
  for (const index of indices) {
    const group = byIndex.get(index);
    if (!group || seen.has(index)) {
      throw new ProblemGenerationParseError(`Evidence index ${index} is not a unique supporting-evidence reference.`, raw);
    }
    seen.add(index);
    for (const item of group.evidence) {
      const origin = evidenceIdByItem.get(item);
      if (!origin) throw new ProblemGenerationParseError("Supporting evidence could not be mapped to the original analysis.", raw);
      refs.push({
        evidence_id: origin.evidence_id,
        hypothesis_id: origin.hypothesis_id,
        url: item.url,
        query: item.query,
        title: item.title,
        source: item.source,
        evidence_summary: item.evidence_summary,
      });
    }
  }
  return refs;
}

const SEMANTIC_CONCEPTS: ReadonlyArray<[string, string[]]> = [
  ["internet_connectivity", ["internetconnectivity", "broadband", "internet", "wifi", "connectivity", "network", "connection"]],
  ["remote_healthcare", ["telehealth", "telemedicine", "teleconsultation", "teleconsultations", "virtualcare", "remotehealthcare", "remoteconsultation", "remoteconsultations"]],
  ["service_disruption", ["servicedisruption", "disconnect", "disconnected", "disconnection", "outage", "interruption", "unstable", "unreliable", "drop", "dropped", "disrupt"]],
  ["cost_burden", ["expensive", "costly", "cost", "costs", "price", "prices", "pricing", "affordability", "affordable"]],
  ["resource_shortage", ["shortage", "shortages", "scarcity", "lack", "lacks", "lacking", "insufficient", "resources", "resource"]],
  ["learning_resources", ["learningresources", "learningresource", "textbooks", "materials", "supplies"]],
  ["inclusive_education", ["inclusive", "inclusion", "inclusivity", "disability", "disabilities", "adaptations", "accommodations"]],
  ["educator_training", ["teachertraining", "training", "trained", "untrained", "professionaldevelopment"]],
];

function semanticSignature(problem: CandidateProblem): Set<string> {
  const meaningText = `${problem.problem_statement} ${problem.mechanism} ${problem.observed_impact}`.toLowerCase()
    .replace(/\b(?:telehealth|telemedicine|teleconsultations?|virtual care|remote healthcare|remote medical (?:appointments?|visits?|consultations?))\b/g, "remotehealthcare")
    .replace(/\b(?:broadband|internet|wifi|connectivity|network|connection)\b/g, "internetconnectivity")
    .replace(/\b(?:disconnect(?:s|ed|ion)?|outages?|interruptions?|unstable|unreliable|drops?|disrupt(?:s|ed)?)\b/g, "servicedisruption");
  const rawWords = normalizedWords(meaningText);
  const signature = new Set<string>();
  for (const word of rawWords) {
    const concept = SEMANTIC_CONCEPTS.find(([name, variants]) => name === word || variants.includes(word))?.[0];
    signature.add(concept ?? word);
  }
  return signature;
}

function semanticSimilarity(a: CandidateProblem, b: CandidateProblem): number {
  const wordsA = semanticSignature(a);
  const wordsB = semanticSignature(b);
  const intersection = [...wordsA].filter((word) => wordsB.has(word));
  const union = new Set([...wordsA, ...wordsB]);
  // Require multiple shared meaning-bearing concepts so related items in one domain
  // (e.g. school resources vs inclusive-education training) remain distinct.
  return intersection.length < 2 ? 0 : intersection.length / union.size;
}

function mergeDuplicateProblems(problems: CandidateProblem[]): CandidateProblem[] {
  const merged: CandidateProblem[] = [];
  for (const problem of problems) {
    const duplicate = merged.find((prior) => semanticSimilarity(prior, problem) >= 0.34);
    if (!duplicate) {
      merged.push(problem);
      continue;
    }
    const detailScore = (candidate: CandidateProblem) => new Set([...normalizedWords(candidate.problem_statement), ...normalizedWords(candidate.mechanism)]).size;
    const preferred = detailScore(problem) > detailScore(duplicate) ? problem : duplicate;
    const seen = new Set(duplicate.evidence_refs.map((ref) => ref.evidence_id));
    duplicate.evidence_refs.push(...problem.evidence_refs.filter((ref) => !seen.has(ref.evidence_id)));
    if (preferred === problem) {
      duplicate.problem_statement = problem.problem_statement;
      duplicate.affected_population = problem.affected_population;
      duplicate.affected_activity = problem.affected_activity;
      duplicate.context = problem.context;
      duplicate.mechanism = problem.mechanism;
      duplicate.observed_impact = problem.observed_impact;
      duplicate.observations = problem.observations;
    }
  }
  // Re-number ids per hypothesis (not by array position): after a global
  // cross-hypothesis merge the flat list interleaves hypotheses, and each
  // hypothesis's candidates must still read h1-p1, h1-p2, …, h2-p1, …
  const sequenceByHypothesis = new Map<string, number>();
  return merged.map((problem) => {
    const next = (sequenceByHypothesis.get(problem.hypothesis_id) ?? 0) + 1;
    sequenceByHypothesis.set(problem.hypothesis_id, next);
    return { ...problem, id: `${problem.hypothesis_id}-p${next}` };
  });
}

async function generateForHypothesis(
  hypothesis: ResearchPlan["hypotheses"][number],
  analysis: HypothesisEvidenceAnalysis,
  getProvider: () => LLMProvider,
  preparedByHypothesis: Map<string, PreparedEvidence>,
  evidenceIdByItem: Map<SourceEvidence, { hypothesis_id: string; evidence_id: string }>
): Promise<Omit<ProblemGenerationResult["hypotheses"][number], "duration_ms">> {
  const prepared = preparedByHypothesis.get(hypothesis.id) ?? prepareEvidence(analysis, hypothesis.id);
  const base = {
    hypothesis_id: hypothesis.id,
    supporting_evidence_count: prepared.supportCount,
    challenging_evidence_count: prepared.challengeCount,
    problems_before_deduplication_count: 0,
  };

  if (analysis.status === "failed") {
    return { ...base, status: "failed", problems: [], error: analysis.error ?? "Evidence analysis failed for this hypothesis." };
  }
  if (analysis.status === "no_evidence" || prepared.supporting.length === 0) {
    return { ...base, status: "no_evidence", problems: [] };
  }
  if (prepared.supportWeight <= prepared.challengeWeight) {
    return { ...base, status: "insufficient_evidence", problems: [] };
  }
  // Observation-first gate: candidates are derived from validated
  // observations, never from the hypothesis or from raw evidence alone.
  // Supporting evidence that produced no validated observation leaves
  // nothing to build a pattern from, so the model is not called at all —
  // a hypothesis by itself can never create a problem.
  if (prepared.citable.length === 0) {
    console.log(
      `[ProblemRadar/ProblemGenerator] hypothesis="${hypothesis.id}" — ${prepared.supportCount} supporting source(s) but no validated observations; skipping the LLM call`
    );
    return { ...base, status: "insufficient_evidence", problems: [] };
  }

  // Cross-hypothesis pattern material: related validated observations from
  // other hypotheses, renumbered into this prompt's citation space — the
  // host's own citable groups stay 1..k, borrowed groups continue after
  // them, challenging groups after those. Unrelated foreign observations
  // are never selected (same relatedness rule validation enforces), and a
  // hypothesis with no citable observations of its own never gets here —
  // the gate above already returned — so a hypothesis alone still cannot
  // create a problem by borrowing someone else's evidence.
  const foreign = selectRelatedForeignGroups(prepared, preparedByHypothesis, hypothesis.id).map((group, position) => ({
    ...group,
    index: prepared.citable.length + position + 1,
  }));
  const challenging = prepared.challenging.map((group, position) => ({
    ...group,
    index: prepared.citable.length + foreign.length + position + 1,
  }));
  const citationGroups = [...prepared.citable, ...foreign];
  const prompt = buildPrompt(hypothesis, prepared.citable, foreign, challenging);
  if (foreign.length > 0) {
    const origins = [...new Set(foreign.map((group) => group.evidence[0]?.hypothesis_id).filter(Boolean))].join(", ");
    console.log(`[ProblemRadar/ProblemGenerator] hypothesis="${hypothesis.id}" offering ${foreign.length} related observation group(s) from other hypothesis(es): ${origins}`);
  }

  const provider = getProvider();
  const generated = await withRetry(
    async (attemptNumber) => {
      const raw = await provider.generateJSON({
        system: "You are ProblemRadar's Problem Generator. Derive concrete candidate problems only from the supplied validated observations (including related observations from other hypotheses) and their cited supporting evidence, weigh the supplied challenges, and output only valid JSON. Never invent facts, citations, or evidence references.",
        prompt,
        temperature: 0.1,
      });
      console.log(`[ProblemRadar/ProblemGenerator] hypothesis="${hypothesis.id}" attempt ${attemptNumber}/2 — raw model output:\n${raw}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJsonObject(raw));
      } catch {
        throw new ProblemGenerationParseError(`Invalid JSON for hypothesis "${hypothesis.id}".`, raw);
      }
      const result = OutputSchema.safeParse(parsed);
      if (!result.success) {
        throw new ProblemGenerationParseError(`Invalid problem output for hypothesis "${hypothesis.id}": ${result.error.message}`, raw);
      }
      // The citation space: this hypothesis's citable groups first, borrowed
      // related groups after them, challenging groups last — only the first
      // two buckets are supporting and may be cited.
      const allGroups = [...citationGroups, ...challenging];
      const groupsByIndex = new Map(allGroups.map((group) => [group.index, group]));
      const accepted = [];
      for (const [problemIndex, problem] of result.data.problems.entries()) {
        try {
          const evidence = problem.evidence_indices.flatMap((index) => {
            const group = groupsByIndex.get(index);
            if (!group) throw new ProblemGenerationParseError(`Unknown evidence index ${index}.`, raw);
            if (group.kind !== "supporting") throw new ProblemGenerationParseError(`Evidence index ${index} refers to challenging evidence and cannot support a candidate problem.`, raw);
            return group.evidence;
          });
          // Every atomic claim must stay inside the candidate's own cited
          // evidence, so its provenance is always visible in evidence_refs.
          const citedIndices = new Set(problem.evidence_indices);
          const observationItems = problem.observations.map((observation) => {
            const items = observation.evidence_indices.flatMap((index) => {
              const group = groupsByIndex.get(index);
              if (!group) throw new ProblemGenerationParseError(`Unknown evidence index ${index}.`, raw);
              if (group.kind !== "supporting") throw new ProblemGenerationParseError(`Evidence index ${index} refers to challenging evidence and cannot support an observation.`, raw);
              if (!citedIndices.has(index)) {
                throw new ProblemGenerationParseError(`observation cites evidence index ${index}, which the candidate problem does not cite — provenance must stay intact.`, raw);
              }
              return group.evidence;
            });
            const validated = observation.evidence_indices.map(
              (index) => validatedObservationText(groupsByIndex.get(index)!)
            );
            return { claim: observation.claim, items, validated };
          });
          // A candidate spanning several evidence items must be a pattern of
          // related observations, not a mash-up of unrelated ones.
          assertPatternIsCoherent(problem.evidence_indices, groupsByIndex, raw);
          assertGrounded(problem, evidence, raw, hypothesis.hypothesis, observationItems);
          accepted.push(problem);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[ProblemRadar/ProblemGenerator] hypothesis="${hypothesis.id}" rejected candidate ${problemIndex + 1}: ${reason}`);
        }
      }
      return accepted;
    },
    {
      maxAttempts: 2,
      isRetryable: (error) => error instanceof ProblemGenerationParseError,
      onRetry: (attemptNumber, error) => console.warn(`[ProblemRadar/ProblemGenerator] hypothesis="${hypothesis.id}" attempt ${attemptNumber}/2 validation failed; retrying: ${error instanceof Error ? error.message : String(error)}`),
    }
  );

  const strength = prepared.supportWeight >= 4 && prepared.challengeWeight === 0 ? "strong" : "moderate";
  const candidates: CandidateProblem[] = generated.map((problem, index) => {
    const evidenceRefs = refsForIndices(problem.evidence_indices, citationGroups, evidenceIdByItem, "validated output");
    return {
      id: `${hypothesis.id}-p${index + 1}`,
      hypothesis_id: hypothesis.id,
      problem_statement: problem.problem_statement.trim(),
      affected_population: problem.affected_population.trim(),
      affected_activity: problem.affected_activity.trim(),
      context: problem.context.trim(),
      mechanism: problem.mechanism.trim(),
      observed_impact: problem.observed_impact.trim(),
      observations: problem.observations.map((observation) => ({ claim: observation.claim.trim(), evidence_indices: observation.evidence_indices })),
      evidence_refs: evidenceRefs,
      evidence_strength: strength,
    };
  });
  const problems = mergeDuplicateProblems(candidates);
  return { ...base, problems_before_deduplication_count: candidates.length, status: problems.length ? "generated" : "insufficient_evidence", problems };
}

/**
 * Small bounded worker pool: each hypothesis is fully independent (its own
 * evidence slice, prompt, LLM call, validation, and references), so they can
 * safely run concurrently. Bounded to avoid hammering the local Ollama
 * server with unbounded parallel requests.
 */
export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** Bounded concurrency: independent hypotheses run in parallel; h3-style no-evidence hypotheses skip the LLM entirely. */
export async function runProblemGenerator(
  plan: ResearchPlan,
  analysis: EvidenceAnalysisRun,
  getProvider: () => LLMProvider = getLLMProvider
): Promise<ProblemGenerationResult> {
  const started = new Date();
  const byId = new Map(analysis.hypotheses.map((item) => [item.hypothesis_id, item]));
  const concurrency = Math.max(1, Number.parseInt(process.env.PROBLEM_GENERATOR_CONCURRENCY ?? "4", 10) || 4);

  // Prepared once, up front: (1) each hypothesis's citable/challenging
  // spaces — so any hypothesis's call can offer related observation groups
  // to any other — and (2) the evidence-origin map for the whole run, so a
  // reference built from a borrowed group resolves to that group's own
  // hypothesis and its position in that hypothesis's evidence array.
  const preparedByHypothesis = new Map<string, PreparedEvidence>();
  for (const hypothesis of plan.hypotheses) {
    const item = byId.get(hypothesis.id);
    if (item) preparedByHypothesis.set(hypothesis.id, prepareEvidence(item, hypothesis.id));
  }
  const evidenceIdByItem = new Map<SourceEvidence, { hypothesis_id: string; evidence_id: string }>();
  for (const item of analysis.hypotheses) {
    item.evidence.forEach((source, index) => {
      evidenceIdByItem.set(source, { hypothesis_id: item.hypothesis_id, evidence_id: `${item.hypothesis_id}:e${index + 1}` });
    });
  }

  console.log(`[ProblemRadar/ProblemGenerator] starting run: ${plan.hypotheses.length} hypothesis(es), concurrency=${concurrency}`);
  const hypotheses = await mapWithConcurrency(plan.hypotheses, concurrency, async (hypothesis) => {
    const analysisItem = byId.get(hypothesis.id);
    const perHypothesisStarted = Date.now();
    if (!analysisItem) {
      return { hypothesis_id: hypothesis.id, status: "failed" as const, duration_ms: 0, supporting_evidence_count: 0, challenging_evidence_count: 0, problems_before_deduplication_count: 0, problems: [], error: "EvidenceAnalysis is missing this hypothesis." };
    }
    try {
      const willCallLlm = analysisItem.status !== "failed" && analysisItem.status !== "no_evidence";
      if (willCallLlm) console.log(`[ProblemRadar/ProblemGenerator] hypothesis="${hypothesis.id}" queued for the LLM call`);
      const result = await generateForHypothesis(hypothesis, analysisItem, getProvider, preparedByHypothesis, evidenceIdByItem);
      return { ...result, duration_ms: Date.now() - perHypothesisStarted };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ProblemRadar/ProblemGenerator] hypothesis="${hypothesis.id}" failed: ${message}`);
      const counts = prepareEvidence(analysisItem, hypothesis.id);
      return { hypothesis_id: hypothesis.id, status: "failed" as const, duration_ms: Date.now() - perHypothesisStarted, supporting_evidence_count: counts.supportCount, challenging_evidence_count: counts.challengeCount, problems_before_deduplication_count: 0, problems: [], error: message };
    }
  });

  // Cross-hypothesis consolidation: semantic deduplication also runs over
  // the whole run, so the same situation found under two research
  // directions collapses into ONE candidate instead of one per hypothesis,
  // with evidence_refs unioned from every hypothesis that found it. Each
  // hypothesis's own list is then rebuilt from the consolidated set, so
  // `problems` stays exactly the union of `hypotheses[].problems` as
  // before. A hypothesis whose candidate was consolidated into another's
  // keeps its "generated" status (it did generate — its
  // problems_before_deduplication_count records that) while its list shows
  // only what it still owns; the kept candidate carries its evidence.
  const problems = mergeDuplicateProblems(hypotheses.flatMap((item) => item.problems));
  const consolidated = hypotheses.map((item) => ({
    ...item,
    problems: problems.filter((problem) => problem.hypothesis_id === item.hypothesis_id),
  }));

  const completed = new Date();
  const result: ProblemGenerationResult = {
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    duration_ms: completed.getTime() - started.getTime(),
    hypotheses: consolidated,
    problems,
    summary: {
      hypothesis_count: consolidated.length,
      generated_hypothesis_count: consolidated.filter((item) => item.status === "generated").length,
      no_evidence_hypothesis_count: consolidated.filter((item) => item.status === "no_evidence").length,
      insufficient_evidence_hypothesis_count: consolidated.filter((item) => item.status === "insufficient_evidence").length,
      failed_hypothesis_count: consolidated.filter((item) => item.status === "failed").length,
      candidate_problem_count_before_deduplication: consolidated.reduce((total, item) => total + item.problems_before_deduplication_count, 0),
      candidate_problem_count: problems.length,
    },
  };
  console.log(`[ProblemRadar/ProblemGenerator] duplicate consolidation: ${result.summary.candidate_problem_count_before_deduplication} candidate(s) before → ${result.summary.candidate_problem_count} after`);
  console.log(`[ProblemRadar/ProblemGenerator] done in ${result.duration_ms}ms — ${problems.length} problem(s), ${result.summary.failed_hypothesis_count} failed hypothesis(es)`);
  console.log(`[ProblemRadar/ProblemGenerator] result:\n${JSON.stringify(result, null, 2)}`);
  return result;
}
