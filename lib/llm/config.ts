/**
 * Central place for "which LLM provider/model are we using". Every other
 * module in `lib/llm/` reads from here instead of `process.env` directly,
 * so switching provider or model later is a one-file change.
 *
 * All of this is server-only (used from route handlers), so plain
 * `process.env` names are fine — nothing here needs `NEXT_PUBLIC_`.
 */

export type LLMProviderName = "ollama";

export const LLM_CONFIG = {
  /** Which provider implementation to use. Only "ollama" exists today. */
  provider: (process.env.LLM_PROVIDER as LLMProviderName) || "ollama",

  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "qwen3:8b",
    /**
     * How long to wait for a local generation before giving up. Generous
     * by default because CPU-only inference of an 8B model, plus a cold
     * model load on the first request, can genuinely take a few minutes.
     */
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS) || 240_000,
  },
} as const;
