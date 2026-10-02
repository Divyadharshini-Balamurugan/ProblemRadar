import { NextResponse } from "next/server";
import { z } from "zod";

import type { EvidenceAnalysisRun, ResearchPlan } from "@/types";
import { EVIDENCE_RECENCY_LEVELS, EVIDENCE_RELEVANCE_LEVELS, EVIDENCE_STANCES, RESEARCH_LENSES } from "@/types";
import { LLMConnectionError } from "@/lib/llm";
import { runProblemGenerator } from "@/lib/llm/problem-generator";

const HypothesisSchema = z.object({
  id: z.string().min(1),
  lens: z.enum(RESEARCH_LENSES),
  hypothesis: z.string().min(1),
  evidence_targets: z.array(z.string()).default([]),
  source_strategies: z.array(z.string()).default([]),
  search_queries: z.array(z.string().min(1)).min(1),
});
const PlanSchema = z.object({
  hypotheses: z.array(HypothesisSchema).min(1),
  search_budget: z.object({
    max_queries_per_hypothesis: z.number().int().positive(),
    max_sources_per_hypothesis: z.number().int().positive(),
    total_query_budget: z.number().int().positive(),
  }),
}) satisfies z.ZodType<ResearchPlan>;

const EvidenceSchema = z.object({
  hypothesis_id: z.string().min(1),
  url: z.string().min(1),
  query: z.string().min(1),
  title: z.string(),
  source: z.string(),
  stance: z.enum(EVIDENCE_STANCES),
  relevance: z.enum(EVIDENCE_RELEVANCE_LEVELS),
  recency: z.enum(EVIDENCE_RECENCY_LEVELS),
  evidence_summary: z.string().min(1),
});
const AnalysisSchema = z.object({
  started_at: z.string(),
  completed_at: z.string(),
  duration_ms: z.number().nonnegative(),
  hypotheses: z.array(z.object({
    hypothesis_id: z.string().min(1),
    lens: z.string(),
    hypothesis: z.string(),
    status: z.enum(["analyzed", "no_evidence", "failed"]),
    error: z.string().optional(),
    evidence: z.array(EvidenceSchema),
    support_count: z.number().int().nonnegative(),
    challenge_count: z.number().int().nonnegative(),
    neutral_count: z.number().int().nonnegative(),
  })),
}) satisfies z.ZodType<EvidenceAnalysisRun>;

const RequestSchema = z.object({ plan: PlanSchema, analysis: AnalysisSchema });

/** Stage 5: turn analyzed, traceable evidence into grounded candidate problems. */
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

  const { plan, analysis } = parsed.data;
  console.log("\n[ProblemRadar/ProblemGenerator] ── input ───────────────────────────");
  console.log(`ResearchPlan: ${plan.hypotheses.length} hypothesis(es). EvidenceAnalysis: ${analysis.hypotheses.length} hypothesis(es).`);

  try {
    const result = await runProblemGenerator(plan, analysis);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof LLMConnectionError) {
      console.error("[ProblemRadar/ProblemGenerator] connection error:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("[ProblemRadar/ProblemGenerator] unexpected error:", message);
    return NextResponse.json({ ok: false, error: "Something went wrong while generating candidate problems." }, { status: 500 });
  }
}
