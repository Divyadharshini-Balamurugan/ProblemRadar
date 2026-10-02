import { z } from "zod";

import type {
  CandidateProblem,
  EvidenceAnalysisRun,
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
  /** Position in the single stable per-hypothesis evidence list (1-based). */
  index: number;
  /** Which bucket this group belongs to; only "supporting" groups may be cited. */
  kind: "supporting" | "challenging";
  evidence: SourceEvidence[];
}

interface PreparedEvidence {
  supporting: EvidenceGroup[];
  challenging: EvidenceGroup[];
  supportWeight: number;
  challengeWeight: number;
  supportCount: number;
  challengeCount: number;
}

function weight(evidence: SourceEvidence): number {
  return evidence.relevance === "high" ? 2 : evidence.relevance === "medium" ? 1 : 0;
}

function groupEvidence(items: SourceEvidence[], kind: EvidenceGroup["kind"], offset: number): EvidenceGroup[] {
  const groups = new Map<string, SourceEvidence[]>();
  for (const item of items) {
    const key = `${item.url.trim().toLowerCase()}\n${item.query.trim().toLowerCase()}\n${item.evidence_summary.trim().toLowerCase()}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].map((evidence, index) => ({ index: offset + index + 1, kind, evidence }));
}

function prepareEvidence(analysis: HypothesisEvidenceAnalysis, hypothesisId: string): PreparedEvidence {
  const supportingItems = analysis.evidence.filter(
    (item) => item.hypothesis_id === hypothesisId && item.stance === "supports" && (item.relevance === "high" || item.relevance === "medium")
  );
  const challengingItems = analysis.evidence.filter(
    (item) => item.hypothesis_id === hypothesisId && item.stance === "challenges" && (item.relevance === "high" || item.relevance === "medium")
  );
  const supportingGroups = groupEvidence(supportingItems, "supporting", 0);
  const challengingGroups = groupEvidence(challengingItems, "challenging", supportingGroups.length);
  return {
    supporting: supportingGroups,
    challenging: challengingGroups,
    supportWeight: supportingItems.reduce((total, item) => total + weight(item), 0),
    challengeWeight: challengingItems.reduce((total, item) => total + weight(item), 0),
    supportCount: supportingItems.length,
    challengeCount: challengingItems.length,
  };
}

function buildPrompt(
  hypothesis: { hypothesis: string },
  supporting: EvidenceGroup[],
  challenging: EvidenceGroup[]
): string {
  const supportText = supporting
    .map(({ index, evidence }) => `${index}. ${evidence.map((item) => `"${item.evidence_summary}" (${item.title}; ${item.source})`).join(" / ")}`)
    .join("\n");
  const challengeText = challenging.length
    ? challenging
        .map(({ index, evidence }) => `${index}. ${evidence.map((item) => `"${item.evidence_summary}" (${item.title}; ${item.source})`).join(" / ")}`)
        .join("\n")
    : "None supplied.";

  return `Research hypothesis (context only; it is not evidence):\n${hypothesis.hypothesis}\n\nSupporting evidence (the only basis for candidate claims; numbered items):\n${supportText}\n\nRelevant challenging evidence (numbered items continuing from the supporting list; weigh them before accepting a problem; they may NOT be cited):\n${challengeText}\n\nReturn zero to three distinct problems. Each problem must cite only the numbers of SUPPORTING evidence items in evidence_indices. Think evidence-first: before writing the problem fields, list the small set of atomic observations you can actually support from the evidence (each with its own evidence_indices), and make every other field a concise synthesis of those observations. Every claim must remain supported by the cited evidence: do not add unsupported facts, statistics, causes, populations, comparisons, impacts, or failures, and do not strengthen what the evidence establishes (e.g. do not turn "some" into "all", or a need for improvement into an existing solution failing). New structured observations must also stay within the evidence: e.g. if the evidence says compliance requirements make business growth harder, you may record that as an observation, but you may NOT add observations about specific approval delays, penalties, or workflows the evidence does not state. Shape each candidate as a concrete situational problem when the evidence supports one: the affected_activity must name the real activity/workflow a person or organization is trying to perform that is difficult or fails. If the evidence only establishes a broad condition without a specific supported activity, keep the candidate broad or omit it. Do not restate the research hypothesis verbatim as the problem statement. Neutral evidence is excluded. Do not create duplicate phrasings of one underlying problem; keep the clearest one and cite all relevant support. Relevant contrary evidence may require returning no problem. Return only this JSON shape:\n{"problems":[{"observations":[{"claim":"...","evidence_indices":[1]}],"problem_statement":"...","affected_population":"...","affected_activity":"...","context":"...","mechanism":"...","observed_impact":"...","evidence_indices":[1]}]}`;
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

function assertGrounded(
  problem: z.infer<typeof GeneratedProblemSchema>,
  evidence: SourceEvidence[],
  raw: string,
  hypothesisText?: string,
  observationItems: Array<{ claim: string; items: SourceEvidence[] }> = []
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
      let supported = 0;
      const unsupported: string[] = [];
      for (const word of fieldWords) {
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

  // Each structured observation must independently ground in its own cited items.
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
    let supported = 0;
    const unsupported: string[] = [];
    for (const word of claimWords) {
      if (itemWords.has(word)) {
        supported += 1;
        continue;
      }
      const group = PARAPHRASE_GROUPS.find((candidate) => candidate.includes(word));
      if (group && group.some((variant) => itemWords.has(variant))) {
        supported += 1;
        continue;
      }
      unsupported.push(word);
    }
    if (supported === 0) {
      throw new ProblemGenerationParseError(`observation is not semantically supported by its cited evidence.`, raw);
    }
    const supportedFraction = supported / claimWords.size;
    const unsupportedBudget = Math.max(2, Math.floor(claimWords.size / 2) + 1);
    if (supportedFraction < 1 / 3 || unsupported.length > unsupportedBudget) {
      throw new ProblemGenerationParseError(`observation contains unsupported claims: ${unsupported.join(", ")}.`, raw);
    }
  }
}

function refsForIndices(
  indices: number[],
  supporting: EvidenceGroup[],
  hypothesisId: string,
  originalEvidence: SourceEvidence[],
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
      const originalIndex = originalEvidence.indexOf(item);
      if (originalIndex < 0) throw new ProblemGenerationParseError("Supporting evidence could not be mapped to the original analysis.", raw);
      refs.push({
        evidence_id: `${hypothesisId}:e${originalIndex + 1}`,
        hypothesis_id: hypothesisId,
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
  return merged.map((problem, index) => ({ ...problem, id: `${problem.hypothesis_id}-p${index + 1}` }));
}

async function generateForHypothesis(
  hypothesis: ResearchPlan["hypotheses"][number],
  analysis: HypothesisEvidenceAnalysis,
  getProvider: () => LLMProvider
): Promise<Omit<ProblemGenerationResult["hypotheses"][number], "duration_ms">> {
  const prepared = prepareEvidence(analysis, hypothesis.id);
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

  const provider = getProvider();
  const generated = await withRetry(
    async (attemptNumber) => {
      const raw = await provider.generateJSON({
        system: "You are ProblemRadar's Problem Generator. Synthesize concrete candidate problems only from the supplied supporting evidence, consider supplied challenges, and output only valid JSON. Never invent facts, citations, or evidence references.",
        prompt: buildPrompt(hypothesis, prepared.supporting, prepared.challenging),
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
      const allGroups = [...prepared.supporting, ...prepared.challenging];
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
          const observationItems = problem.observations.map((observation) => ({
            claim: observation.claim,
            items: observation.evidence_indices.flatMap((index) => {
              const group = groupsByIndex.get(index);
              if (!group) throw new ProblemGenerationParseError(`Unknown evidence index ${index}.`, raw);
              if (group.kind !== "supporting") throw new ProblemGenerationParseError(`Evidence index ${index} refers to challenging evidence and cannot support an observation.`, raw);
              return group.evidence;
            }),
          }));
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
    const evidenceRefs = refsForIndices(problem.evidence_indices, prepared.supporting, hypothesis.id, analysis.evidence, "validated output");
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
      const result = await generateForHypothesis(hypothesis, analysisItem, getProvider);
      return { ...result, duration_ms: Date.now() - perHypothesisStarted };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ProblemRadar/ProblemGenerator] hypothesis="${hypothesis.id}" failed: ${message}`);
      const counts = prepareEvidence(analysisItem, hypothesis.id);
      return { hypothesis_id: hypothesis.id, status: "failed" as const, duration_ms: Date.now() - perHypothesisStarted, supporting_evidence_count: counts.supportCount, challenging_evidence_count: counts.challengeCount, problems_before_deduplication_count: 0, problems: [], error: message };
    }
  });

  const completed = new Date();
  const problems = hypotheses.flatMap((item) => item.problems);
  const result: ProblemGenerationResult = {
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    duration_ms: completed.getTime() - started.getTime(),
    hypotheses,
    problems,
    summary: {
      hypothesis_count: hypotheses.length,
      generated_hypothesis_count: hypotheses.filter((item) => item.status === "generated").length,
      no_evidence_hypothesis_count: hypotheses.filter((item) => item.status === "no_evidence").length,
      insufficient_evidence_hypothesis_count: hypotheses.filter((item) => item.status === "insufficient_evidence").length,
      failed_hypothesis_count: hypotheses.filter((item) => item.status === "failed").length,
      candidate_problem_count_before_deduplication: hypotheses.reduce((total, item) => total + item.problems_before_deduplication_count, 0),
      candidate_problem_count: problems.length,
    },
  };
  console.log(`[ProblemRadar/ProblemGenerator] duplicate consolidation: ${result.summary.candidate_problem_count_before_deduplication} candidate(s) before → ${result.summary.candidate_problem_count} after`);
  console.log(`[ProblemRadar/ProblemGenerator] done in ${result.duration_ms}ms — ${problems.length} problem(s), ${result.summary.failed_hypothesis_count} failed hypothesis(es)`);
  console.log(`[ProblemRadar/ProblemGenerator] result:\n${JSON.stringify(result, null, 2)}`);
  return result;
}
