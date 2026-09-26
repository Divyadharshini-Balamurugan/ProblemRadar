/**
 * Provider-agnostic contract every LLM backend must implement. Agents
 * (like the Intent/Scope Agent in `lib/llm/intent-agent.ts`) code against
 * this interface only — never against a specific provider's SDK/API —
 * so swapping Ollama for another provider later never touches agent code.
 */
export interface GenerateJSONParams {
  /** Optional system/instruction message. */
  system?: string;
  /** The user-facing prompt asking for a JSON response. */
  prompt: string;
  /** Sampling temperature. Low (e.g. 0.1) for structured extraction. */
  temperature?: number;
}

export interface LLMProvider {
  /** Short identifier, used only for logging (e.g. "ollama"). */
  readonly name: string;
  /**
   * Ask the model to produce a JSON response and return its raw text
   * content. Callers are responsible for parsing/validating that text —
   * this layer only guarantees "the provider was reached and it replied
   * with some content", not "the content is valid JSON".
   */
  generateJSON(params: GenerateJSONParams): Promise<string>;
}
