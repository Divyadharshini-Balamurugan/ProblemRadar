import { LLM_CONFIG } from "./config";
import type { LLMProvider } from "./provider";
import { OllamaProvider } from "./providers/ollama-provider";

let cachedProvider: LLMProvider | null = null;

/**
 * The single place that decides which `LLMProvider` implementation is
 * active, based on `LLM_CONFIG.provider`. Agents call this instead of
 * constructing a provider directly, so adding a second provider later is
 * just another `case` here.
 */
export function getLLMProvider(): LLMProvider {
  if (cachedProvider) return cachedProvider;

  switch (LLM_CONFIG.provider) {
    case "ollama":
    default:
      cachedProvider = new OllamaProvider();
      break;
  }

  return cachedProvider;
}

export type { GenerateJSONParams, LLMProvider } from "./provider";
export { LLM_CONFIG } from "./config";
export { LLMConnectionError } from "./providers/ollama-provider";
