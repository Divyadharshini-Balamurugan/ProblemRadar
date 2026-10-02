/**
 * Retries an LLM "call the model, then parse/validate its output" step a
 * bounded number of times. Ollama's `format: "json"` only guarantees
 * *syntactically valid* JSON, not that it matches a specific shape — so a
 * local model occasionally emits a well-formed object that's still
 * missing a key or has a stray one. Since generation is non-deterministic,
 * asking again is often enough to get a clean response.
 *
 * Deliberately narrow: only errors the caller marks retryable via
 * `isRetryable` are retried. A connection failure (`LLMConnectionError`)
 * is never retryable here — the model/server being unreachable won't
 * resolve itself within the same request, so retrying just doubles the
 * wait for the same failure.
 */
export async function withRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: {
    maxAttempts: number;
    isRetryable: (error: unknown) => boolean;
    onRetry?: (attemptNumber: number, error: unknown) => void;
  }
): Promise<T> {
  let lastError: unknown;

  for (let attemptNumber = 1; attemptNumber <= options.maxAttempts; attemptNumber++) {
    try {
      return await attempt(attemptNumber);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attemptNumber === options.maxAttempts;
      if (!options.isRetryable(error) || isLastAttempt) {
        throw error;
      }
      options.onRetry?.(attemptNumber, error);
    }
  }

  // Unreachable in practice (the loop always returns or throws), but keeps
  // TypeScript happy about every code path returning/throwing.
  throw lastError;
}
