import { LLM_CONFIG } from "../config";
import type { GenerateJSONParams, LLMProvider } from "../provider";

/**
 * Thrown when we can't reach Ollama at all, or it responds with a
 * non-2xx status. Distinct from `IntentParseError` (in intent-agent.ts),
 * which means "we got a response but it wasn't valid/expected JSON".
 */
export class LLMConnectionError extends Error {}

interface OllamaChatResponse {
  message?: { role?: string; content?: string };
}

/**
 * Talks to a local Ollama server's `/api/chat` endpoint. This is the only
 * file that knows Ollama's request/response shape — everything else in
 * the app depends on the generic `LLMProvider` interface instead.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options?: { baseUrl?: string; model?: string; timeoutMs?: number }) {
    this.baseUrl = options?.baseUrl ?? LLM_CONFIG.ollama.baseUrl;
    this.model = options?.model ?? LLM_CONFIG.ollama.model;
    this.timeoutMs = options?.timeoutMs ?? LLM_CONFIG.ollama.timeoutMs;
  }

  async generateJSON({ system, prompt, temperature = 0.1 }: GenerateJSONParams): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    console.log(
      `[ollama] requesting "${this.model}" (this can take a while on the first call, or on CPU-only hardware)...`
    );
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          // Ollama constrains generation to valid JSON when this is set.
          format: "json",
          // Qwen3 (and other reasoning models) can otherwise burn most of
          // the response budget on a hidden <think> block, which also
          // fights with `format: "json"` (the grammar rejects "thinking"
          // tokens, the model keeps trying anyway) and can make a request
          // extremely slow or appear to hang. This is the reliable,
          // API-level way to turn that off — the "/no_think" text hint
          // below is a harmless fallback for older Ollama builds that
          // don't support this field.
          think: false,
          options: { temperature },
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: `${prompt}\n\n/no_think` },
          ],
        }),
      });
      console.log(`[ollama] responded in ${Date.now() - startedAt}ms`);
    } catch (cause) {
      const isAbort = cause instanceof Error && cause.name === "AbortError";
      throw new LLMConnectionError(
        isAbort
          ? `Ollama did not respond within ${this.timeoutMs}ms (model "${this.model}"). This usually means it's loading the model into memory for the first time, or running slowly on CPU-only hardware — try again once "ollama ps" (in another terminal) shows the model loaded, or raise OLLAMA_TIMEOUT_MS in .env.local.`
          : `Could not reach Ollama at ${this.baseUrl}. Is "ollama serve" running, and is the "${this.model}" model pulled? (npm run check:ollama checks this for you)`
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LLMConnectionError(
        `Ollama returned ${response.status} ${response.statusText} for model "${this.model}".${
          body ? ` ${body}` : ""
        }`.trim()
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message?.content;
    if (!content) {
      throw new LLMConnectionError("Ollama returned an empty response.");
    }
    return content;
  }
}
