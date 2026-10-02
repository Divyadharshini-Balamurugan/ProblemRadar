/**
 * Central place for "how do we call SerpApi". Mirrors lib/llm/config.ts's
 * pattern: every other module in `lib/search/` reads from here instead of
 * `process.env` directly, so tuning timeouts/result counts later is a
 * one-file change.
 *
 * Server-only (used from the search API route and lib/search/* services),
 * so the API key never needs a `NEXT_PUBLIC_` prefix and is never sent to
 * the browser.
 */
export const SERPAPI_CONFIG = {
  /** Only ever read from server code — never exposed to the client bundle. */
  apiKey: process.env.SERPAPI_API_KEY || "",

  /** SerpApi's search endpoint. Overridable mainly for testing against a stand-in server. */
  baseUrl: process.env.SERPAPI_BASE_URL || "https://serpapi.com/search.json",

  /**
   * How long to wait for one SerpApi call before giving up on that single
   * query. A timeout here just means that one (hypothesis, query) pair is
   * recorded as an "error" execution — it never aborts the whole run.
   */
  timeoutMs: Number(process.env.SERPAPI_TIMEOUT_MS) || 15_000,

  /** How many organic results to request (and keep, before dedup) per query. */
  resultsPerQuery: Number(process.env.SERPAPI_RESULTS_PER_QUERY) || 5,

  /**
   * Small politeness delay between consecutive SerpApi calls. Searches run
   * sequentially in this first implementation specifically to stay well
   * clear of rate limits — this delay is the other half of that.
   */
  delayBetweenQueriesMs: Number(process.env.SERPAPI_DELAY_MS) || 300,
} as const;
