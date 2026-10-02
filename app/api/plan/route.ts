import { NextResponse } from "next/server";
import { z } from "zod";

import { LLMConnectionError } from "@/lib/llm";
import { IntentScopeSchema } from "@/lib/llm/intent-agent";
import { generateResearchPlan, ResearchPlanParseError } from "@/lib/llm/research-planner";

const RequestSchema = z.object({
  // Optional — used only so this stage's console output is self-explanatory.
  // The planner's actual input is `intent`, not the raw query.
  query: z.string().trim().optional(),
  intent: IntentScopeSchema,
});

/**
 * Stage 2 of the ProblemRadar research pipeline: Research Planner.
 *
 * Takes an already-validated Intent/Scope object (stage 1's output —
 * this route does not re-derive it from raw text) and produces a
 * validated ResearchPlan: a small, diverse set of research hypotheses
 * plus a deterministic search budget. No web search, no SerpApi calls,
 * and no result of this stage is investigated any further yet.
 *
 * Independently testable: this route only needs `{ intent }` in its
 * body, so it can be exercised directly with a hand-written IntentScope
 * — it does not require going through /api/intent first. Example:
 *
 *   curl -X POST http://localhost:3000/api/plan \
 *     -H "Content-Type: application/json" \
 *     -d '{"intent":{"intent":"investigate","domain":"freelance work","audience":"freelance designers","location":null,"specific_problem":"losing track of unpaid invoices","breadth":"narrow","time_scope":"current","research_targets":["invoicing habits","existing tools"]}}'
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const parsedRequest = RequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return NextResponse.json(
      { ok: false, error: parsedRequest.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 }
    );
  }

  const { query, intent } = parsedRequest.data;

  console.log("\n[ProblemRadar/ResearchPlanner] ── input Intent/Scope ──────────────");
  if (query) console.log(`(for original query: "${query}")`);
  console.log(JSON.stringify(intent, null, 2));

  try {
    const plan = await generateResearchPlan(intent);

    console.log("[ProblemRadar/ResearchPlanner] ── generated ResearchPlan ──────────");
    console.log(JSON.stringify(plan, null, 2));
    console.log("[ProblemRadar/ResearchPlanner] ── search queries by hypothesis ──────");
    for (const hypothesis of plan.hypotheses) {
      console.log(`${hypothesis.id} (${hypothesis.lens}) — ${hypothesis.hypothesis}`);
      hypothesis.search_queries.forEach((searchQuery, index) => {
        console.log(`  ${index + 1}. ${searchQuery}`);
      });
    }
    console.log("[ProblemRadar/ResearchPlanner] ────────────────────────────────────\n");

    return NextResponse.json({ ok: true, plan });
  } catch (error) {
    if (error instanceof LLMConnectionError) {
      console.error("[ProblemRadar/ResearchPlanner] connection error:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    }

    if (error instanceof ResearchPlanParseError) {
      console.error("[ProblemRadar/ResearchPlanner] invalid plan from model:", error.message);
      console.error("[ProblemRadar/ResearchPlanner] raw model output:\n", error.raw);
      return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    }

    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("[ProblemRadar/ResearchPlanner] unexpected error:", message);
    return NextResponse.json(
      { ok: false, error: "Something went wrong while planning research for this request." },
      { status: 500 }
    );
  }
}
