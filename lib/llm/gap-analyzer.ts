import { z } from "zod";

import type {
  CandidateProblem,
  CandidateGapAnalysis,
  ExistingSolution,
  GapAnalysisResult,
  GapConfidence,
  GapEvidenceReference,
  SolutionCoverage,
  UnresolvedGap,
} from "@/types";
import { extractJsonObject } from "./json-utils";
import { getLLMProvider, type LLMProvider } from "./index";
import { mapWithConcurrency } from "./problem-generator";
import { searchSerpApi, type RawSearchItem } from "../search/serpapi-client";
import { withRetry } from "./with-retry";

export class GapAnalysisParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = "GapAnalysisParseError";
  }
}

/** How one source of gap-analysis evidence is collected — injectable for tests, real SerpApi by default. */
export type GapSearchFn = (query: string, options?: { numResults?: number }) => Promise<RawSearchItem[]>;

/** Bounds: focused evidence collection, not massive web crawling. */
const MAX_QUERIES_PER_CANDIDATE = 5;
const RESULTS_PER_QUERY = 5;
const MAX_KEPT_ITEMS_PER_CANDIDATE = 8;
const MAX_ATTEMPTS = 2;

const ExistingSolutionSchema = z.object({
  name: z.string().min(2).max(120),
  type: z.string().min(2).max(60),
  description: z.string().min(3).max(300),
  target_population: z.string().min(2).max(160),
  evidence_indices: z.array(z.number().int().positive()).min(1).max(8),
});

const UnresolvedGapSchema = z.object({
  gap: z.string().min(3).max(160),
  explanation: z.string().min(3).max(300),
  evidence_indices: z.array(z.number().int().positive()).min(1).max(8),
});

const GapAnalysisOutputSchema = z.object({
  existing_solutions: z.array(ExistingSolutionSchema).max(10),
  addressed_aspects: z.array(z.string().min(2).max(200)).max(10),
  unresolved_gaps: z.array(UnresolvedGapSchema).max(10),
  solution_coverage: z.enum(["clear", "partial", "insufficient_solution_evidence"]),
  gap_confidence: z.enum(["high", "moderate", "low"]),
});

/** One normalized, deduplicated gap-search source item, numbered 1..n for the prompt. */
interface NumberedItem {
  index: number;
  item: RawSearchItem & { query: string };
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

/**
 * Deterministic, problem-specific query templates. All of them are built
 * from the candidate's own statement/affected population, so they can't
 * drift into unrelated broad queries like "rural problems".
 */
export function buildGapQueries(problem: CandidateProblem): string[] {
  const statement = problem.problem_statement.replace(/\.$/, "").trim();
  const population = problem.affected_population.trim();
  const candidates = [
    `${statement} existing solutions programs services`,
    `${population} ${problem.affected_activity} programs interventions`,
    `${statement} intervention effectiveness results`,
    `${statement} limitations challenges adoption barriers`,
    `${population} ${problem.affected_activity} government NGO technology solutions`,
  ];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const query of candidates) {
    const key = query.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      queries.push(query);
    }
    if (queries.length >= MAX_QUERIES_PER_CANDIDATE) break;
  }
  return queries;
}

async function collectSolutionEvidence(
  problem: CandidateProblem,
  queries: string[],
  search: GapSearchFn
): Promise<{ items: NumberedItem[]; queriesExecuted: string[]; errors: string[] }> {
  const items: NumberedItem[] = [];
  const queriesExecuted: string[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();
  for (const query of queries) {
    try {
      const rawItems = await search(query, { numResults: RESULTS_PER_QUERY });
      queriesExecuted.push(query);
      for (const item of rawItems) {
        if (items.length >= MAX_KEPT_ITEMS_PER_CANDIDATE) break;
        let key = item.link;
        try {
          const parsed = new URL(item.link);
          key = `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
        } catch {
          /* fall back to raw link */
        }
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        items.push({ index: items.length + 1, item: { ...item, query } });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (items.length >= MAX_KEPT_ITEMS_PER_CANDIDATE) break;
  }
  return { items, queriesExecuted, errors };
}

function buildPrompt(problem: CandidateProblem, items: NumberedItem[]): string {
  const lines = items
    .map(({ index, item }) => `${index}. title: "${truncate(item.title, 160)}" | snippet: "${truncate(item.snippet, 300)}" | source: "${item.source}"`)
    .join("\n");
  return `Candidate problem (evidence-grounded; context only):
"${problem.problem_statement}"
Affected population: ${problem.affected_population}
Activity affected: ${problem.affected_activity}
Context: ${problem.context}
Mechanism: ${problem.mechanism}
Observed impact: ${problem.observed_impact}

Real search results about existing solutions for this problem (the only allowed basis):
${lines}

Task: identify CONCRETE existing solutions (products, services, platforms, programs, policies, organizations, workflows, technologies) that these results establish, what aspects of the candidate problem they address, and what evidence-supported gap REMAINS. Consider availability, coverage, affordability, accessibility, adoption, reliability, capacity, coordination, awareness, and population fit — but report a gap ONLY when the cited results support it. Paraphrase freely, but do not add statistics, populations, geographies, or capabilities the cited items don't state. Never write "no solution exists", "nobody has solved this", or "no competitors" — "no evidence found" is not evidence that nothing exists. Each solution/gap must cite the numbers of its supporting items in evidence_indices.

Output ONLY this JSON shape:
{"existing_solutions":[{"name":"...","type":"...","description":"...","target_population":"...","evidence_indices":[1]}],"addressed_aspects":["..."],"unresolved_gaps":[{"gap":"...","explanation":"...","evidence_indices":[1]}],"solution_coverage":"clear|partial|insufficient_solution_evidence","gap_confidence":"high|moderate|low"}`;
}

/** Groundedness guardrail: a meaningful share of the text's substantive words must appear in the cited sources (same family of check as the Evidence Analyzer's, lenient enough for paraphrase). */
const GROUNDEDNESS_THRESHOLD = 0.3;

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3)
  );
}

function isGrounded(text: string, sourceText: string): boolean {
  const words = contentWords(text);
  if (words.size === 0) return false;
  const sourceWords = contentWords(sourceText);
  let shared = 0;
  for (const word of words) if (sourceWords.has(word)) shared += 1;
  return shared / words.size >= GROUNDEDNESS_THRESHOLD;
}

const NUMBER_PATTERN = /\d+(?:\.\d+)?/g;
function hasUnsupportedNumbers(text: string, sourceText: string): boolean {
  const sourceNumbers = new Set(sourceText.match(NUMBER_PATTERN) ?? []);
  const own = text.match(NUMBER_PATTERN) ?? [];
  return own.some((n) => !sourceNumbers.has(n));
}

/** Absolute "nothing exists" claims ordinary search cannot establish — reject them. */
const ABSOLUTE_NO_SOLUTION = /(no solution(s)? exist|nobody has solved|no one has solved|no competitors?|market is empty|no service exists|nothing exists)/i;

function assertGapAnalysisSound(
  output: z.infer<typeof GapAnalysisOutputSchema>,
  items: NumberedItem[],
  raw: string
): void {
  const byIndex = new Map(items.map((entry) => [entry.index, entry]));
  const joinSource = (indices: number[]): NumberedItem[] => indices.map((index) => {
    const entry = byIndex.get(index);
    if (!entry) throw new GapAnalysisParseError(`Evidence index ${index} is not one of the ${items.length} numbered items.`, raw);
    return entry;
  });

  const ground = (text: string, indices: number[], what: string) => {
    const sourceText = joinSource(indices).map((entry) => `${entry.item.title} ${entry.item.snippet}`).join(" ");
    if (ABSOLUTE_NO_SOLUTION.test(text)) {
      throw new GapAnalysisParseError(`${what} claims that no solution exists — search results cannot establish that.`, raw);
    }
    if (hasUnsupportedNumbers(text, sourceText)) {
      throw new GapAnalysisParseError(`${what} contains a statistic absent from its cited evidence.`, raw);
    }
    if (!isGrounded(text, sourceText)) {
      throw new GapAnalysisParseError(`${what} is not semantically grounded in its cited evidence.`, raw);
    }
  };

  for (const solution of output.existing_solutions) {
    ground(`${solution.description} ${solution.target_population}`, solution.evidence_indices, `solution "${solution.name}"`);
  }
  for (const gap of output.unresolved_gaps) {
    ground(gap.explanation, gap.evidence_indices, `gap "${gap.gap}"`);
  }
  for (const aspect of output.addressed_aspects) {
    // Addressed aspects summarize across solutions, so allow grounding
    // against the union of all cited items.
    const anySourceText = items.map((entry) => `${entry.item.title} ${entry.item.snippet}`).join(" ");
    if (!isGrounded(aspect, anySourceText)) {
      throw new GapAnalysisParseError(`addressed_aspects entry is not semantically grounded in the cited evidence.`, raw);
    }
  }
  if (ABSOLUTE_NO_SOLUTION.test(JSON.stringify(output))) {
    throw new GapAnalysisParseError("Output claims that no solution exists — search results cannot establish that.", raw);
  }
}

function refsForIndices(problem: CandidateProblem, items: NumberedItem[], indices: number[], raw: string): GapEvidenceReference[] {
  const byIndex = new Map(items.map((entry) => [entry.index, entry]));
  const seen = new Set<number>();
  const refs: GapEvidenceReference[] = [];
  for (const index of indices) {
    if (seen.has(index)) continue;
    seen.add(index);
    const entry = byIndex.get(index);
    if (!entry) throw new GapAnalysisParseError(`Unknown evidence index ${index}.`, raw);
    refs.push({
      solution_evidence_id: `${problem.id}:s${entry.index}`,
      candidate_problem_id: problem.id,
      url: entry.item.link,
      query: entry.item.query,
      title: entry.item.title,
      source: entry.item.source,
      evidence_summary: truncate(entry.item.snippet, 300),
    });
  }
  return refs;
}

/** Consolidate sources describing the same solution into one entry with merged evidence refs. */
function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function dedupeSolutions(solutions: ExistingSolution[]): ExistingSolution[] {
  const merged: ExistingSolution[] = [];
  for (const solution of solutions) {
    const existing = merged.find((prior) => jaccard(wordSet(prior.name), wordSet(solution.name)) >= 0.6);
    if (!existing) {
      merged.push({ ...solution, evidence_refs: [...solution.evidence_refs] });
      continue;
    }
    const seen = new Set(existing.evidence_refs.map((ref) => ref.solution_evidence_id));
    existing.evidence_refs.push(...solution.evidence_refs.filter((ref) => !seen.has(ref.solution_evidence_id)));
  }
  return merged;
}

function dedupeGaps(gaps: UnresolvedGap[]): UnresolvedGap[] {
  const merged: UnresolvedGap[] = [];
  for (const gap of gaps) {
    const existing = merged.find((prior) => jaccard(wordSet(prior.gap), wordSet(gap.gap)) >= 0.6);
    if (!existing) {
      merged.push({ ...gap, evidence_refs: [...gap.evidence_refs] });
      continue;
    }
    const seen = new Set(existing.evidence_refs.map((ref) => ref.solution_evidence_id));
    existing.evidence_refs.push(...gap.evidence_refs.filter((ref) => !seen.has(ref.solution_evidence_id)));
  }
  return merged;
}

function baseItem(problem: CandidateProblem): Pick<CandidateGapAnalysis, "id" | "candidate_problem_id" | "problem_statement"> {
  return { id: `${problem.id}-g1`, candidate_problem_id: problem.id, problem_statement: problem.problem_statement };
}

async function analyzeCandidate(problem: CandidateProblem, getProvider: () => LLMProvider, search: GapSearchFn): Promise<CandidateGapAnalysis> {
  const started = Date.now();
  const queries = buildGapQueries(problem);
  const { items, queriesExecuted, errors } = await collectSolutionEvidence(problem, queries, search);

  if (items.length === 0) {
    return {
      ...baseItem(problem),
      status: "insufficient_evidence",
      duration_ms: Date.now() - started,
      queries_executed: queriesExecuted,
      existing_solutions: [],
      addressed_aspects: [],
      unresolved_gaps: [],
      solution_coverage: "insufficient_solution_evidence",
      gap_confidence: "low",
      evidence_refs: [],
      error: errors.length ? `No usable solution evidence: ${errors[0]}` : "No usable solution evidence found.",
    };
  }

  const provider = getProvider();
  const output = await withRetry(
    async (attemptNumber) => {
      const raw = await provider.generateJSON({
        system: "You are ProblemRadar's Gap Analyzer. Identify existing solutions and evidence-supported gaps for the given problem using ONLY the numbered search results provided. Never invent facts, statistics, populations, or solutions, and never claim no solution exists. Output only valid JSON.",
        prompt: buildPrompt(problem, items),
        temperature: 0.1,
      });
      console.log(`[ProblemRadar/GapAnalysis] candidate="${problem.id}" attempt ${attemptNumber}/${MAX_ATTEMPTS} — raw model output:\n${raw}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJsonObject(raw));
      } catch {
        throw new GapAnalysisParseError(`Invalid JSON for candidate "${problem.id}".`, raw);
      }
      const result = GapAnalysisOutputSchema.safeParse(parsed);
      if (!result.success) {
        throw new GapAnalysisParseError(`Invalid gap-analysis output for candidate "${problem.id}": ${result.error.message}`, raw);
      }
      assertGapAnalysisSound(result.data, items, raw);
      return result.data;
    },
    {
      maxAttempts: MAX_ATTEMPTS,
      isRetryable: (error) => error instanceof GapAnalysisParseError,
      onRetry: (attemptNumber, error) => console.warn(`[ProblemRadar/GapAnalysis] candidate="${problem.id}" attempt ${attemptNumber}/${MAX_ATTEMPTS} failed validation; retrying: ${error instanceof Error ? error.message : String(error)}`),
    }
  );

  const existing_solutions: ExistingSolution[] = dedupeSolutions(
    output.existing_solutions.map((solution) => ({
      name: solution.name.trim(),
      type: solution.type.trim(),
      description: solution.description.trim(),
      target_population: solution.target_population.trim(),
      evidence_refs: refsForIndices(problem, items, solution.evidence_indices, "validated output"),
    }))
  );
  const unresolved_gaps: UnresolvedGap[] = dedupeGaps(
    output.unresolved_gaps.map((gap) => ({
      gap: gap.gap.trim(),
      explanation: gap.explanation.trim(),
      evidence_refs: refsForIndices(problem, items, gap.evidence_indices, "validated output"),
    }))
  );
  const evidence_refs = dedupeRefs([...existing_solutions.flatMap((s) => s.evidence_refs), ...unresolved_gaps.flatMap((g) => g.evidence_refs)]);
  const coverage: SolutionCoverage = existing_solutions.length === 0 ? "insufficient_solution_evidence" : output.solution_coverage;
  const gap_confidence: GapConfidence = output.gap_confidence;

  return {
    ...baseItem(problem),
    status: existing_solutions.length === 0 && unresolved_gaps.length === 0 ? "insufficient_evidence" : "analyzed",
    duration_ms: Date.now() - started,
    queries_executed: queriesExecuted,
    existing_solutions,
    addressed_aspects: output.addressed_aspects,
    unresolved_gaps,
    solution_coverage: coverage,
    gap_confidence,
    evidence_refs,
  };
}

function dedupeRefs(refs: GapEvidenceReference[]): GapEvidenceReference[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.solution_evidence_id)) return false;
    seen.add(ref.solution_evidence_id);
    return true;
  });
}

/** Independent candidates run with the same bounded-concurrency pattern as the Problem Generator. */
export async function runGapAnalysis(
  problems: CandidateProblem[],
  options?: { getProvider?: () => LLMProvider; search?: GapSearchFn; concurrency?: number }
): Promise<GapAnalysisResult> {
  const started = new Date();
  const getProvider = options?.getProvider ?? getLLMProvider;
  const search = options?.search ?? searchSerpApi;
  const concurrency = options?.concurrency ?? Math.max(1, Number.parseInt(process.env.GAP_ANALYSIS_CONCURRENCY ?? "4", 10) || 4);

  console.log(`[ProblemRadar/GapAnalysis] starting run: ${problems.length} candidate problem(s), concurrency=${concurrency}`);
  const analyses = await mapWithConcurrency(problems, concurrency, async (problem) => {
    const perCandidateStarted = Date.now();
    try {
      return await analyzeCandidate(problem, getProvider, search);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ProblemRadar/GapAnalysis] candidate="${problem.id}" failed: ${message}`);
      return {
        ...baseItem(problem),
        status: "failed" as const,
        duration_ms: Date.now() - perCandidateStarted,
        queries_executed: [],
        existing_solutions: [],
        addressed_aspects: [],
        unresolved_gaps: [],
        solution_coverage: "insufficient_solution_evidence" as SolutionCoverage,
        gap_confidence: "low" as GapConfidence,
        evidence_refs: [],
        error: message,
      };
    }
  });

  const completed = new Date();
  const result: GapAnalysisResult = {
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    duration_ms: completed.getTime() - started.getTime(),
    analyses,
    summary: {
      candidate_count: analyses.length,
      analyzed_count: analyses.filter((item) => item.status === "analyzed").length,
      insufficient_evidence_count: analyses.filter((item) => item.status === "insufficient_evidence").length,
      failed_count: analyses.filter((item) => item.status === "failed").length,
      solution_count: analyses.reduce((total, item) => total + item.existing_solutions.length, 0),
      gap_count: analyses.reduce((total, item) => total + item.unresolved_gaps.length, 0),
      queries_executed_count: analyses.reduce((total, item) => total + item.queries_executed.length, 0),
    },
  };
  console.log(`[ProblemRadar/GapAnalysis] done in ${result.duration_ms}ms — ${result.summary.solution_count} solution(s), ${result.summary.gap_count} gap(s), ${result.summary.failed_count} failed`);
  console.log(`[ProblemRadar/GapAnalysis] result:\n${JSON.stringify(result, null, 2)}`);
  return result;
}
