/**
 * Output shape of the Search Orchestrator (ProblemRadar research pipeline,
 * stage 3). Takes a validated `ResearchPlan` (stage 2's output) and turns
 * its `search_queries` into real, budget-bounded SerpApi searches, then
 * normalizes the results into a stable internal shape — still no scoring,
 * ranking, or synthesis here, just reliable retrieval with full
 * hypothesis-to-result traceability for a future evidence-analysis stage.
 */

/** One normalized web-search result, always traceable back to the hypothesis and query that found it. */
export interface SearchResult {
  /** Which hypothesis (by id) this result is evidence for. */
  hypothesis_id: string;
  /** The exact query string that returned this result. */
  query: string;
  title: string;
  /** The result's URL, as returned by SerpApi (not canonicalized — see the orchestrator for the dedup key). */
  url: string;
  snippet: string;
  /** Domain/source the result came from (e.g. "timesofindia.indiatimes.com"). */
  source: string;
  /** 1-based rank of this result within its query's results. */
  position: number;
  /** Best-effort publication date as SerpApi reports it, or null if none was provided. */
  published_date: string | null;
}

/** What happened when the orchestrator considered/ran one (hypothesis, query) pair. */
export type SearchExecutionStatus = "success" | "error" | "skipped_duplicate_query" | "skipped_budget_exhausted";

export interface SearchExecution {
  hypothesis_id: string;
  query: string;
  status: SearchExecutionStatus;
  /** How many normalized results this execution contributed (0 unless status is "success"). */
  result_count: number;
  /** Present when status is "error": a human-readable failure reason. */
  error?: string;
  /** Present when status is a "skipped_*" status: why it was skipped. */
  reason?: string;
  /** Present when status is "success" or "error": how long the SerpApi call took. */
  latency_ms?: number;
}

/** How the plan's `search_budget` was actually spent by this run. */
export interface SearchBudgetUsage {
  total_query_budget: number;
  max_queries_per_hypothesis: number;
  max_sources_per_hypothesis: number;
  queries_executed: number;
  queries_skipped_duplicate: number;
  queries_skipped_budget: number;
  /** Unique (post-dedup) result count actually kept, per hypothesis id. */
  sources_returned_per_hypothesis: Record<string, number>;
}

/** The full record of one Search Orchestrator run — everything needed to debug or audit it. */
export interface SearchRun {
  started_at: string;
  completed_at: string;
  duration_ms: number;
  /** One entry per (hypothesis, query) pair considered, in the order it was processed. */
  executions: SearchExecution[];
  /** All normalized, deduplicated results kept across the whole run. */
  results: SearchResult[];
  budget_usage: SearchBudgetUsage;
}
