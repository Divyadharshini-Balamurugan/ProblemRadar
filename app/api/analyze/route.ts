import { NextResponse } from "next/server";
import { z } from "zod";

import type { ResearchPlan, SearchRun } from "@/types";
import { DISCOVERY_ANGLES, RESEARCH_LENSES } from "@/types";
import { LLMConnectionError } from "@/lib/llm";
import { runEvidenceAnalyzer } from "@/lib/llm/evidence-analyzer";

/**
 * Stage 4 of the ProblemRadar research pipeline: Evidence Analyzer.
 *
 * Takes an already-validated `ResearchPlan` (stage 2's output) and its
 * matching `SearchRun` (stage 3's output — this route does not call
 * SerpApi or re-run search) and produces structured, source-traceable
 * evidence for every hypothesis in the plan. The LLM (Ollama/Qwen3, same
 * as stages 1–2) is used only to interpret already-retrieved text —
 * classify each source's stance, judge its relevance, and extract a
 * grounded evidence summary — never to search the web.
 *
 * This route defines its own request schemas below rather than importing
 * the Research Planner's or Search Orchestrator's internal (unexported)
 * Zod schemas — same reasoning as `/api/search`: this stage should only
 * depend on the public `ResearchPlan`/`SearchRun` *shapes*, so it stays
 * independently testable with hand-written fixtures:
 *
 *   curl -X POST http://localhost:3000/api/analyze \
 *     -H "Content-Type: application/json" \
 *     -d '{"plan": { "hypotheses": [...], "search_budget": {...} }, "run": { "started_at": "...", "completed_at": "...", "duration_ms": 0, "executions": [...], "results": [...], "budget_usage": {...} }}'
 *
 * The response's `analysis` field (one entry per hypothesis, each with
 * its own `status` and full `evidence` list) is itself the debugging view
 * into what the analyzer did — nothing is hidden or summarized away.
 */
const HypothesisRequestSchema = z.object({
  id: z.string().min(1),
  lens: z.enum(RESEARCH_LENSES),
  angle: z.enum(DISCOVERY_ANGLES),
  hypothesis: z.string().min(1),
  evidence_targets: z.array(z.string()).default([]),
  source_strategies: z.array(z.string()).default([]),
  search_queries: z.array(z.string().min(1)).min(1),
});

const SearchBudgetRequestSchema = z.object({
  max_queries_per_hypothesis: z.number().int().positive(),
  max_sources_per_hypothesis: z.number().int().positive(),
  total_query_budget: z.number().int().positive(),
});

const ResearchPlanRequestSchema = z.object({
  hypotheses: z.array(HypothesisRequestSchema).min(1),
  search_budget: SearchBudgetRequestSchema,
}) satisfies z.ZodType<ResearchPlan>;

const SearchResultRequestSchema = z.object({
  hypothesis_id: z.string().min(1),
  query: z.string().min(1),
  title: z.string(),
  url: z.string().min(1),
  snippet: z.string(),
  source: z.string(),
  position: z.number().int(),
  published_date: z.string().nullable(),
});

const SearchExecutionRequestSchema = z.object({
  hypothesis_id: z.string().min(1),
  query: z.string().min(1),
  status: z.enum(["success", "error", "skipped_duplicate_query", "skipped_budget_exhausted"]),
  result_count: z.number().int().nonnegative(),
  error: z.string().optional(),
  reason: z.string().optional(),
  latency_ms: z.number().optional(),
});

const SearchBudgetUsageRequestSchema = z.object({
  total_query_budget: z.number().int().nonnegative(),
  max_queries_per_hypothesis: z.number().int().nonnegative(),
  max_sources_per_hypothesis: z.number().int().nonnegative(),
  queries_executed: z.number().int().nonnegative(),
  queries_skipped_duplicate: z.number().int().nonnegative(),
  queries_skipped_budget: z.number().int().nonnegative(),
  sources_returned_per_hypothesis: z.record(z.string(), z.number().int().nonnegative()),
});

const SearchRunRequestSchema = z.object({
  started_at: z.string(),
  completed_at: z.string(),
  duration_ms: z.number(),
  executions: z.array(SearchExecutionRequestSchema),
  results: z.array(SearchResultRequestSchema),
  budget_usage: SearchBudgetUsageRequestSchema,
}) satisfies z.ZodType<SearchRun>;

const RequestSchema = z.object({
  plan: ResearchPlanRequestSchema,
  run: SearchRunRequestSchema,
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsedRequest = RequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return NextResponse.json(
      { ok: false, error: parsedRequest.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 }
    );
  }

  const { plan, run } = parsedRequest.data as { plan: ResearchPlan; run: SearchRun };

  console.log("\n[ProblemRadar/EvidenceAnalyzer] ── input ─────────────────────────────");
  console.log(
    `ResearchPlan: ${plan.hypotheses.length} hypothesis(es). SearchRun: ${run.results.length} result(s) across ${run.executions.length} execution(s).`
  );
  console.log(JSON.stringify(plan.hypotheses.map((h) => ({ id: h.id, lens: h.lens, hypothesis: h.hypothesis })), null, 2));

  try {
    const analysis = await runEvidenceAnalyzer(plan, run);

    console.log("[ProblemRadar/EvidenceAnalyzer] ── EvidenceAnalysis summary ─────────");
    console.log(
      JSON.stringify(
        {
          duration_ms: analysis.duration_ms,
          hypotheses: analysis.hypotheses.map((h) => ({
            hypothesis_id: h.hypothesis_id,
            status: h.status,
            support_count: h.support_count,
            challenge_count: h.challenge_count,
            neutral_count: h.neutral_count,
          })),
        },
        null,
        2
      )
    );
    console.log("[ProblemRadar/EvidenceAnalyzer] ─────────────────────────────────────\n");

    return NextResponse.json({ ok: true, analysis });
  } catch (error) {
    // `runEvidenceAnalyzer` already catches every per-hypothesis failure
    // (connection errors included) and records it as `status: "failed"`
    // — reaching here means something unexpected happened outside that
    // per-hypothesis loop (a bug), not a normal LLM/validation failure,
    // which is why this is a 500, not a 502.
    if (error instanceof LLMConnectionError) {
      console.error("[ProblemRadar/EvidenceAnalyzer] connection error:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    }

    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("[ProblemRadar/EvidenceAnalyzer] unexpected error:", message);
    return NextResponse.json(
      { ok: false, error: "Something went wrong while analyzing evidence for this research plan." },
      { status: 500 }
    );
  }
}
