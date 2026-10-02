/**
 * Small, dependency-free helpers for pulling a JSON object out of raw LLM
 * text. Shared by every agent in `lib/llm/` (intent-agent.ts,
 * research-planner.ts, ...) so parsing quirks are fixed in one place.
 */

/** Strips a leaked <think>...</think> block, if the model included one anyway. */
export function stripThinking(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Best-effort extraction of the outermost {...} object from the model's text. */
export function extractJsonObject(raw: string): string {
  const cleaned = stripThinking(raw);
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return cleaned;
  }
  return cleaned.slice(firstBrace, lastBrace + 1);
}

/**
 * Some models occasionally emit the *text* "null" or "JSON null" for a
 * nullable field instead of the actual JSON `null` literal — echoing a
 * prompt instruction like "otherwise JSON null" back as a string rather
 * than following it. Given a parsed JSON object and the list of keys that
 * are allowed to be null, coerces any such string back to a real `null`
 * before schema validation sees it, so this quirk doesn't leak into
 * downstream data as if it were a meaningful value.
 */
export function coerceNullLiterals(value: unknown, nullableKeys: string[]): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of nullableKeys) {
    const current = result[key];
    if (typeof current === "string" && /^(json\s+)?null$/i.test(current.trim())) {
      result[key] = null;
    }
  }
  return result;
}
