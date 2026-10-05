import { NextResponse } from "next/server";
import { z } from "zod";

import type { CandidateProblem, GapAnalysisResult } from "@/types";
import { runProblemRanking } from "@/lib/ranking/problem-ranker";

const ProblemEvidenceReferenceSchema = z.object({
  evidence_id: z.string().min(1),
  hypothesis_id: z.string().min(1),
  url: z.string().min(1),
  query: z.string().min(1),
  title: z.string(),
  source: z.string(),
  evidence_summary: z.string(),
});

const CandidateObservationSchema = z.object({
  claim: z.string().min(3),
  evidence_indices: z.array(z.number().int().positive()),
});

const CandidateProblemSchema = z.object({
  id: z.string().min(1),
  hypothesis_id: z.string().min(1),
  problem_statement: z.string().min(1),
  affected_population: z.string().min(1),
  affected_activity: z.string().min(1),
  context: z.string().min(1),
  mechanism: z.string().min(1),
  observed_impact: z.string().min(1),
  evidence_refs: z.array(ProblemEvidenceReferenceSchema),
  evidence_strength: z.enum(["strong", "moderate"]),
  // Validated Phase 3 observations — the ranker scores
  // observation coverage from them, so they must survive
  // request validation (zod strips keys a schema doesn't declare).
  observations: z.array(CandidateObservationSchema).optional(),
}) satisfies z.ZodType<CandidateProblem>;

const GapEvidenceReferenceSchema = z.object({
  solution_evidence_id: z.string().min(1),
  candidate_problem_id: z.string().min(1),
  url: z.string().min(1),
  query: z.string().min(1),
  title: z.string(),
  source: z.string(),
  evidence_summary: z.string(),
});

const ExistingSolutionSchema = z.object({
  name: z.string().min(1),
  type: z.string(),
  description: z.string(),
  target_population: z.string(),
  evidence_refs: z.array(GapEvidenceReferenceSchema),
});

const UnresolvedGapSchema = z.object({
  gap: z.string().min(1),
  explanation: z.string(),
  evidence_refs: z.array(GapEvidenceReferenceSchema),
});

const CandidateGapAnalysisSchema = z.object({
  id: z.string().min(1),
  candidate_problem_id: z.string().min(1),
  problem_statement: z.string(),
  status: z.enum(["analyzed", "insufficient_evidence", "failed"]),
  duration_ms: z.number().nonnegative(),
  queries_executed: z.array(z.string()),
  existing_solutions: z.array(ExistingSolutionSchema),
  addressed_aspects: z.array(z.string()),
  unresolved_gaps: z.array(UnresolvedGapSchema),
  solution_coverage: z.enum(["clear", "partial", "insufficient_solution_evidence"]),
  gap_confidence: z.enum(["high", "moderate", "low"]),
  evidence_refs: z.array(GapEvidenceReferenceSchema),
  error: z.string().optional(),
});

const GapAnalysisResultSchema = z.object({
  started_at: z.string(),
  completed_at: z.string(),
  duration_ms: z.number().nonnegative(),
  analyses: z.array(CandidateGapAnalysisSchema),
  summary: z.object({
    candidate_count: z.number().int().nonnegative(),
    analyzed_count: z.number().int().nonnegative(),
    insufficient_evidence_count: z.number().int().nonnegative(),
    failed_count: z.number().int().nonnegative(),
    solution_count: z.number().int().nonnegative(),
    gap_count: z.number().int().nonnegative(),
    queries_executed_count: z.number().int().nonnegative(),
  }),
}) satisfies z.ZodType<GapAnalysisResult>;

const RequestSchema = z.object({
  problems: z.array(CandidateProblemSchema),
  gap_analysis: GapAnalysisResultSchema,
});

/** Stage 7: deterministically rank validated candidate problems by opportunity. No LLM, no search. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }

  const { problems, gap_analysis } = parsed.data;
  console.log("\n[ProblemRadar/ProblemRanker] ── input ───────────────────────────");
  console.log(`Candidate problems: ${problems.length}. Gap analyses: ${gap_analysis.analyses.length}.`);

  try {
    const result = runProblemRanking(problems, gap_analysis);
    console.log(`[ProblemRadar/ProblemRanker] done — status=${result.status}, rankable=${result.summary.rankable_count}/${result.summary.candidate_count}`);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("[ProblemRadar/ProblemRanker] unexpected error:", message);
    return NextResponse.json({ ok: false, error: "Something went wrong while ranking candidate problems." }, { status: 500 });
  }
}
