import { NextResponse } from "next/server";
import { z } from "zod";

import { LLMConnectionError } from "@/lib/llm";
import { extractIntentScope, IntentParseError } from "@/lib/llm/intent-agent";

const RequestSchema = z.object({
  query: z.string().trim().min(1, "\"query\" must not be empty."),
});

/**
 * Stage 1 of the ProblemRadar research pipeline: Intent/Scope Agent.
 *
 * Takes a free-text research question, sends it to the configured local
 * LLM (Ollama + Qwen3 by default — see lib/llm/), and returns the
 * extracted Intent/Scope JSON. No web search and no research planning
 * happen here or anywhere else yet.
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

  const { query } = parsedRequest.data;

  // Requirement: print the user input clearly in the backend console.
  console.log("\n[ProblemRadar/IntentAgent] ── user input ──────────────────────");
  console.log(query);

  try {
    const intent = await extractIntentScope(query);

    // Requirement: print the parsed + validated Intent/Scope JSON clearly.
    console.log("[ProblemRadar/IntentAgent] ── parsed Intent/Scope JSON ────────");
    console.log(JSON.stringify(intent, null, 2));
    console.log("[ProblemRadar/IntentAgent] ────────────────────────────────────\n");

    return NextResponse.json({ ok: true, intent });
  } catch (error) {
    if (error instanceof LLMConnectionError) {
      console.error("[ProblemRadar/IntentAgent] connection error:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    }

    if (error instanceof IntentParseError) {
      console.error("[ProblemRadar/IntentAgent] invalid JSON from model:", error.message);
      console.error("[ProblemRadar/IntentAgent] raw model output:\n", error.raw);
      return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    }

    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error("[ProblemRadar/IntentAgent] unexpected error:", message);
    return NextResponse.json(
      { ok: false, error: "Something went wrong while understanding your request." },
      { status: 500 }
    );
  }
}
