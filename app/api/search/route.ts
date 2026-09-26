import { NextResponse } from "next/server";
import { z } from "zod";

import type { ResearchPlan } from "@/types";
import { RESEARCH_LENSES } from "@/types";
import { runSearchOrchestrator } from "@/lib/search/search-orchestrator";

/**
 * Stage 3 of the ProblemRadar research pipeline: SERPAPI Search Layer.
 *
 * Takes an already-validated ResearchPlan (stage 2's output — this route
 * does not re-derive it from anything) and executes real, budget-bounded
 * SerpApi searches for it, returning normalized results with full
 * hypothesis-to-result traceability. No LLM is involved in this stage.
 *
 * This route defines its own request schema below rather than importing
 * the Research Planner's internal Zod schema — that schema isn't exported
 * (deliberately: it encodes the Planner's own prompt-shaping constraints,
 * like hypothesis text length bounds), and this stage should only depend
 * on the public `ResearchPlan` *shape*, not the Planner's private
 * validation internals. That keeps this layer independently testable
 * with a hand-written ResearchPlan:
 *
 *   curl -X POST http://localhost:3000/api/search \
 *     -H "Content-Type: application/json" \
 *     -d '{"plan": { "hypotheses": [...], "search_budget": {...} }}'
 *
 * The response's `run` field (executions + results + budget_usage) is
 * itself the "simple debugging response" this stage calls for — nothing
 * is hidden or summarized away.
 */
const HypothesisRequestSchema = z.object({
  id: z.string().min(1),
  lens: z.enum(RESEARCH_LENSES),
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

const RequestSchema = z.object({
  plan: ResearchPlanRequestSchema,
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

  const { plan } = parsedRequest.data;

  console.log("\n[ProblemRadar/SearchOrchestrator] ── input ResearchPlan ──────────────");
  console.log(JSON.stringify(plan, null, 2));

  try {
    const run = await runSearchOrchestrator(plan);

    console.log("[ProblemRadar/SearchOrchestrator] ── SearchRun summary ───────────────");
    console.log(
      JSON.stringify(
        {
          duration_ms: run.duration_ms,
          budget_usage: run.budget_usage,
          execution_count: run.executions.length,
          result_count: run.results.length,
        },
        null,
        2
      )
    );
    console.log("[ProblemRadar/SearchOrchestrator] ─────────────────────────────────────\n");

    return NextResponse.json({ ok: true, run });
  } catch (error) {
    // The orchestrator itself catches every per-query failure — reaching
    // here means something unexpected happened outside that (a bug), not
    // a SerpApi/network issue, which is why this is a 500, not a 502.
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("[ProblemRadar/SearchOrchestrator] unexpected error:", message);
    return NextResponse.json(
      { ok: false, error: "Something went wrong while running searches for this research plan." },
      { status: 500 }
    );
  }
}
