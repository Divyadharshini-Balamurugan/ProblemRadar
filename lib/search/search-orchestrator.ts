import type {
  ResearchHypothesis,
  ResearchPlan,
  SearchBudgetUsage,
  SearchExecution,
  SearchExecutionStatus,
  SearchResult,
  SearchRun,
} from "@/types";
import { SERPAPI_CONFIG } from "./config";
import { SerpApiError, searchSerpApi } from "./serpapi-client";

/**
 * Queries this similar (word-overlap) are treated as near-duplicates and
 * skipped. Kept a bit higher than the Research Planner's own
 * hypothesis-text threshold (0.6) — short search queries naturally share
 * more of their words than full sentences do, so a lower bar here would
 * reject legitimately distinct queries.
 */
const NEAR_DUPLICATE_QUERY_THRESHOLD = 0.75;

function normalizeQueryWords(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2)
  );
}

/** Jaccard word-overlap similarity — same approach as the Research Planner's hypothesis-text check, applied here to query strings instead. */
function querySimilarity(a: string, b: string): number {
  const setA = normalizeQueryWords(a);
  const setB = normalizeQueryWords(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Strips protocol, a leading "www.", and a trailing slash, and ignores
 * the query string/hash, so equivalent URLs (http vs https, with/without
 * "www.", with/without a tracking query string) collapse to the same
 * dedup key instead of being treated as distinct sources.
 */
function canonicalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function skip(
  hypothesis: ResearchHypothesis,
  query: string,
  status: SearchExecutionStatus,
  reason: string
): SearchExecution {
  return { hypothesis_id: hypothesis.id, query, status, result_count: 0, reason };
}

/**
 * Stage 3 of the ProblemRadar research pipeline: the deterministic Search
 * Orchestrator. Turns a validated ResearchPlan's `search_queries` into
 * real, budget-bounded SerpApi calls and normalizes what comes back — no
 * LLM anywhere in this module, and no scoring/ranking/synthesis of the
 * results, just reliable, fully-traceable retrieval.
 *
 * For every (hypothesis, query) pair, in order, the budget/dedup checks
 * run in this order before anything is executed:
 *   1. has this hypothesis already hit `max_sources_per_hypothesis`?
 *   2. has this hypothesis already run `max_queries_per_hypothesis` queries?
 *   3. has the whole plan already hit `total_query_budget`?
 *   4. is this query identical (or near-identical) to one already run?
 * Only once a query survives all four does it actually call SerpApi — and
 * that call is wrapped in its own try/catch, so one bad/slow/rate-limited
 * query never aborts the rest of the run.
 *
 * Searches run strictly sequentially (with a small politeness delay
 * between calls) — deliberate for this first implementation, to stay
 * clear of rate limits; concurrency can be revisited once correctness is
 * verified.
 */
export async function runSearchOrchestrator(plan: ResearchPlan): Promise<SearchRun> {
  const startedAt = new Date();
  const { max_queries_per_hypothesis, max_sources_per_hypothesis, total_query_budget } = plan.search_budget;

  console.log(
    `[ProblemRadar/SearchOrchestrator] starting run: ${plan.hypotheses.length} hypothesis(es), ` +
      `budget=${JSON.stringify(plan.search_budget)}`
  );

  const executions: SearchExecution[] = [];
  const results: SearchResult[] = [];

  const seenExactQueries = new Set<string>();
  const acceptedQueryTexts: string[] = [];
  const seenCanonicalUrls = new Set<string>();
  const sourcesReturnedPerHypothesis: Record<string, number> = {};

  let queriesExecuted = 0;
  let queriesSkippedDuplicate = 0;
  let queriesSkippedBudget = 0;

  for (const hypothesis of plan.hypotheses) {
    sourcesReturnedPerHypothesis[hypothesis.id] = 0;
    let queriesForThisHypothesis = 0;

    for (const query of hypothesis.search_queries) {
      // 1. Per-hypothesis source cap already met — running more queries here can't add anything useful.
      if (sourcesReturnedPerHypothesis[hypothesis.id] >= max_sources_per_hypothesis) {
        executions.push(
          skip(
            hypothesis,
            query,
            "skipped_budget_exhausted",
            `hypothesis "${hypothesis.id}" already has ${sourcesReturnedPerHypothesis[hypothesis.id]} source(s) (max_sources_per_hypothesis=${max_sources_per_hypothesis})`
          )
        );
        queriesSkippedBudget += 1;
        continue;
      }

      // 2. Per-hypothesis query cap.
      if (queriesForThisHypothesis >= max_queries_per_hypothesis) {
        executions.push(
          skip(
            hypothesis,
            query,
            "skipped_budget_exhausted",
            `hypothesis "${hypothesis.id}" already ran ${queriesForThisHypothesis} quer(y/ies) (max_queries_per_hypothesis=${max_queries_per_hypothesis})`
          )
        );
        queriesSkippedBudget += 1;
        continue;
      }

      // 3. Global query budget across the whole plan.
      if (queriesExecuted >= total_query_budget) {
        executions.push(
          skip(hypothesis, query, "skipped_budget_exhausted", `total_query_budget (${total_query_budget}) already reached`)
        );
        queriesSkippedBudget += 1;
        continue;
      }

      // 4. Dedup — exact match first (cheap), then near-duplicate word-overlap, both across the *whole* plan, not just this hypothesis.
      const normalized = query.trim().toLowerCase();
      if (seenExactQueries.has(normalized)) {
        executions.push(skip(hypothesis, query, "skipped_duplicate_query", "identical to an earlier query in this plan"));
        queriesSkippedDuplicate += 1;
        continue;
      }
      const nearDuplicateOf = acceptedQueryTexts.find(
        (prior) => querySimilarity(prior, query) >= NEAR_DUPLICATE_QUERY_THRESHOLD
      );
      if (nearDuplicateOf) {
        executions.push(
          skip(hypothesis, query, "skipped_duplicate_query", `near-duplicate of an earlier query ("${nearDuplicateOf}")`)
        );
        queriesSkippedDuplicate += 1;
        continue;
      }

      // Reserve this query's slot before calling out, so a slow/erroring call can't be double-counted against the budget by anything re-entrant.
      seenExactQueries.add(normalized);
      acceptedQueryTexts.push(query);
      queriesForThisHypothesis += 1;
      queriesExecuted += 1;

      const executionStartedAt = Date.now();
      try {
        console.log(`[ProblemRadar/SearchOrchestrator] → hypothesis="${hypothesis.id}" query="${query}"`);
        const rawItems = await searchSerpApi(query, { numResults: SERPAPI_CONFIG.resultsPerQuery });
        const latencyMs = Date.now() - executionStartedAt;

        let keptCount = 0;
        for (const item of rawItems) {
          if (sourcesReturnedPerHypothesis[hypothesis.id] >= max_sources_per_hypothesis) break;

          const canonical = canonicalizeUrl(item.link);
          if (seenCanonicalUrls.has(canonical)) continue; // same source already returned elsewhere in this run
          seenCanonicalUrls.add(canonical);

          results.push({
            hypothesis_id: hypothesis.id,
            query,
            title: item.title,
            url: item.link,
            snippet: item.snippet,
            source: item.source,
            position: item.position,
            published_date: item.date,
          });
          sourcesReturnedPerHypothesis[hypothesis.id] += 1;
          keptCount += 1;
        }

        executions.push({
          hypothesis_id: hypothesis.id,
          query,
          status: "success",
          result_count: keptCount,
          latency_ms: latencyMs,
        });
        console.log(
          `[ProblemRadar/SearchOrchestrator] ✓ hypothesis="${hypothesis.id}" query="${query}" — ${rawItems.length} raw result(s), ${keptCount} kept after dedup, ${latencyMs}ms`
        );
      } catch (error) {
        const latencyMs = Date.now() - executionStartedAt;
        const message =
          error instanceof SerpApiError
            ? `[${error.kind}] ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error);

        executions.push({
          hypothesis_id: hypothesis.id,
          query,
          status: "error",
          result_count: 0,
          error: message,
          latency_ms: latencyMs,
        });
        console.warn(
          `[ProblemRadar/SearchOrchestrator] ✗ hypothesis="${hypothesis.id}" query="${query}" failed after ${latencyMs}ms: ${message}`
        );
      }

      if (SERPAPI_CONFIG.delayBetweenQueriesMs > 0) {
        await sleep(SERPAPI_CONFIG.delayBetweenQueriesMs);
      }
    }
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();

  const budgetUsage: SearchBudgetUsage = {
    total_query_budget,
    max_queries_per_hypothesis,
    max_sources_per_hypothesis,
    queries_executed: queriesExecuted,
    queries_skipped_duplicate: queriesSkippedDuplicate,
    queries_skipped_budget: queriesSkippedBudget,
    sources_returned_per_hypothesis: sourcesReturnedPerHypothesis,
  };

  console.log(
    `[ProblemRadar/SearchOrchestrator] done in ${durationMs}ms — executed ${queriesExecuted}/${total_query_budget} quer(y/ies), ` +
      `skipped ${queriesSkippedDuplicate} duplicate + ${queriesSkippedBudget} over-budget, kept ${results.length} result(s)`
  );

  return {
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: durationMs,
    executions,
    results,
    budget_usage: budgetUsage,
  };
}
