import { NextResponse } from "next/server";
import { z } from "zod";

import { LLMConnectionError } from "@/lib/llm";
import { runGapAnalysis } from "@/lib/llm/gap-analyzer";

const EvidenceRefSchema = z.object({
  evidence_id: z.string().min(1),
  hypothesis_id: z.string().min(1),
  url: z.string().min(1),
  query: z.string().min(1),
  title: z.string(),
  source: z.string(),
  evidence_summary: z.string(),
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
  evidence_refs: z.array(EvidenceRefSchema),
  evidence_strength: z.enum(["strong", "moderate"]),
});

const RequestSchema = z.object({ problems: z.array(CandidateProblemSchema) });

/** Stage 6: turn final deduplicated candidate problems into evidence-grounded existing-solution and gap analyses. */
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

  const { problems } = parsed.data;
  console.log(`\n[ProblemRadar/GapAnalysis] ── input ───────────────────────────\n${problems.length} candidate problem(s)`);

  try {
    const result = await runGapAnalysis(problems);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof LLMConnectionError) {
      console.error("[ProblemRadar/GapAnalysis] connection error:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("[ProblemRadar/GapAnalysis] unexpected error:", message);
    return NextResponse.json({ ok: false, error: "Something went wrong while analyzing gaps." }, { status: 500 });
  }
}
