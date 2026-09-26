import { z } from "zod";

import type { IntentScope } from "@/types";
import { coerceNullLiterals, extractJsonObject } from "./json-utils";
import { getLLMProvider } from "./index";
import { withRetry } from "./with-retry";

/**
 * Thrown when the model responded, but its text wasn't valid JSON, or
 * the JSON didn't match the expected Intent/Scope structure. Distinct
 * from `LLMConnectionError` (couldn't reach the model at all).
 */
export class IntentParseError extends Error {
  constructor(
    message: string,
    /** The raw, unparsed text the model returned — useful for debugging. */
    public readonly raw: string
  ) {
    super(message);
    this.name = "IntentParseError";
  }
}

/**
 * Structural validation for the Intent/Scope Agent's output. Deliberately
 * lenient on *values* (we don't enforce `intent` to be exactly one of a
 * fixed enum, since models phrase things slightly differently) but strict
 * on *shape*: all 8 keys must be present with the right JSON types.
 *
 * Exported so the Research Planner (stage 2) can validate an `IntentScope`
 * it receives as *input* with the exact same rules used to produce it.
 */
export const IntentScopeSchema = z.object({
  intent: z.string().min(1),
  domain: z.string().min(1),
  audience: z.string().min(1),
  location: z.string().nullable(),
  specific_problem: z.string().nullable(),
  breadth: z.string().min(1),
  time_scope: z.string().min(1),
  research_targets: z.array(z.string()).min(1),
}) satisfies z.ZodType<IntentScope>;

const SYSTEM_PROMPT = `You are the Intent/Scope Agent inside ProblemRadar, a tool that helps people discover real, evidence-backed problems worth solving.
Your only job is to read a user's research question and extract its intent and scope as a single strict JSON object. You do not answer the question, you do not search the web, and you do not suggest problems or solutions. Reply with JSON only: no prose, no markdown code fences, no <think> reasoning.`;

function buildPrompt(query: string): string {
  return `User's research question:
"""
${query}
"""

Extract the following fields and return ONLY a single JSON object with exactly these 8 keys:

- "intent": one of "discover" (user doesn't know what to build yet), "explore" (user wants to explore an industry/audience/location), "investigate" (user already has a specific problem in mind), or "other".
- "domain": the industry, market, or subject area implied (e.g. "healthcare", "freelance work", "agriculture"). Use "unspecified" if none is implied.
- "audience": the specific group of people affected (e.g. "small clinic owners", "freelance designers"). Use "unspecified" if none is implied.
- "location": a specific place, region, or country if one is mentioned. If none is mentioned, this field's JSON value must be the literal null — not the text "null" or "JSON null".
- "specific_problem": the specific problem the user already has in mind (cleaned up, one sentence). If none is mentioned, this field's JSON value must be the literal null — not the text "null" or "JSON null".
- "breadth": how broad the request is — "narrow", "broad", or "exploratory".
- "time_scope": any timeframe implied (e.g. "current", "last 2 years", "emerging trends"). Use "current" if none is implied.
- "research_targets": a JSON array of 2 to 5 short strings naming concrete things worth researching next (sub-topics, source types, or angles).

Return ONLY the JSON object — no other text.`;
}

/**
 * How many times to ask the model again if its JSON doesn't parse or
 * validate. `format: "json"` only guarantees syntactically valid JSON, not
 * a specific shape, so an occasional malformed response is expected —
 * retrying once is usually enough since generation isn't deterministic.
 */
const MAX_ATTEMPTS = 2;

/**
 * Stage 1 of the ProblemRadar research pipeline: turn a free-text
 * research question into structured Intent/Scope JSON. No web search, no
 * planning — just understanding what was asked.
 */
export async function extractIntentScope(query: string): Promise<IntentScope> {
  const provider = getLLMProvider();

  return withRetry(
    async (attemptNumber) => {
      const raw = await provider.generateJSON({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(query),
        temperature: 0.1,
      });

      const jsonText = extractJsonObject(raw);

      let parsedUnknown: unknown;
      try {
        parsedUnknown = JSON.parse(jsonText);
      } catch {
        throw new IntentParseError(
          `The model (${provider.name}) did not return valid JSON${
            attemptNumber > 1 ? ` (attempt ${attemptNumber}/${MAX_ATTEMPTS})` : ""
          }.`,
          raw
        );
      }

      // Defensive: some models echo "otherwise JSON null" back as the
      // literal string "JSON null" instead of following it. Coerce that
      // back to a real null before it reaches validation/downstream code.
      const coerced = coerceNullLiterals(parsedUnknown, ["location", "specific_problem"]);

      const result = IntentScopeSchema.safeParse(coerced);
      if (!result.success) {
        throw new IntentParseError(
          `The model's JSON did not match the expected Intent/Scope structure: ${result.error.message}`,
          raw
        );
      }

      return result.data;
    },
    {
      maxAttempts: MAX_ATTEMPTS,
      isRetryable: (error) => error instanceof IntentParseError,
      onRetry: (attemptNumber, error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[ProblemRadar/IntentAgent] attempt ${attemptNumber}/${MAX_ATTEMPTS} produced invalid JSON, retrying: ${message}`
        );
        if (error instanceof IntentParseError) {
          console.warn(`[ProblemRadar/IntentAgent] raw output for failed attempt:\n${error.raw}`);
        }
      },
    }
  );
}
