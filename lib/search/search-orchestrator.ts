import type {
  ResearchHypothesis,
  ResearchPlan,
  SearchBudgetUsage,
  SearchExecution,
  SearchExecutionStatus,
  SearchResult,
  SearchRun,
} from "@/types";
import { mapWithConcurrency } from "../llm/problem-generator";
import { SERPAPI_CONFIG } from "./config";
import { SerpApiError, searchSerpApi, type RawSearchItem } from "./serpapi-client";

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
 * Independent queries execute with bounded concurrency (SEARCH_CONCURRENCY,
 * default 4) using the shared `mapWithConcurrency` pool — one slow or
 * failing query never blocks independent ones. Planning is deterministic:
 * the same budget/dedup checks run up front (in hypothesis/query order), so
 * executions/results are merged back in that order — provenance, budget
 * accounting, and ordering are identical to the strictly-sequential design.
 */
export async function runSearchOrchestrator(
  plan: ResearchPlan,
  options?: { searchFn?: typeof searchSerpApi; concurrency?: number }
): Promise<SearchRun> {
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

  /** Planning slots keep skipped-vs-runnable entries in the exact plan order so merging is deterministic. */
  interface ExecSlot {
    kind: "skip" | "run";
    hypothesis: ResearchHypothesis;
    query: string;
    skipStatus?: SearchExecutionStatus;
    skipReason?: string;
  }
  const slots: ExecSlot[] = [];

  for (const hypothesis of plan.hypotheses) {
    sourcesReturnedPerHypothesis[hypothesis.id] = 0;
    let queriesForThisHypothesis = 0;

    for (const query of hypothesis.search_queries) {
      // 2. Per-hypothesis query cap.
      if (queriesForThisHypothesis >= max_queries_per_hypothesis) {
        slots.push({ kind: "skip", hypothesis, query, skipStatus: "skipped_budget_exhausted", skipReason: `hypothesis "${hypothesis.id}" already ran ${queriesForThisHypothesis} quer(y/ies) (max_queries_per_hypothesis=${max_queries_per_hypothesis})` });
        queriesSkippedBudget += 1;
        continue;
      }

      // 3. Global query budget across the whole plan.
      if (queriesExecuted >= total_query_budget) {
        slots.push({ kind: "skip", hypothesis, query, skipStatus: "skipped_budget_exhausted", skipReason: `total_query_budget (${total_query_budget}) already reached` });
        queriesSkippedBudget += 1;
        continue;
      }

      // 4. Dedup — exact match first (cheap), then near-duplicate word-overlap, both across the *whole* plan, not just this hypothesis.
      const normalized = query.trim().toLowerCase();
      if (seenExactQueries.has(normalized)) {
        slots.push({ kind: "skip", hypothesis, query, skipStatus: "skipped_duplicate_query", skipReason: "identical to an earlier query in this plan" });
        queriesSkippedDuplicate += 1;
        continue;
      }
      const nearDuplicateOf = acceptedQueryTexts.find(
        (prior) => querySimilarity(prior, query) >= NEAR_DUPLICATE_QUERY_THRESHOLD
      );
      if (nearDuplicateOf) {
        slots.push({ kind: "skip", hypothesis, query, skipStatus: "skipped_duplicate_query", skipReason: `near-duplicate of an earlier query ("${nearDuplicateOf}")` });
        queriesSkippedDuplicate += 1;
        continue;
      }

      seenExactQueries.add(normalized);
      acceptedQueryTexts.push(query);
      queriesForThisHypothesis += 1;
      queriesExecuted += 1;
      slots.push({ kind: "run", hypothesis, query });
    }
  }

  // Execute the "run" queries with bounded concurrency; the shared
  // `mapWithConcurrency` pool is reused from the Problem Generator. One
  // timed-out/erroring query becomes an isolated error execution, never a
  // broken run.
  const concurrency = Math.max(1, options?.concurrency ?? (Number.parseInt(process.env.SEARCH_CONCURRENCY ?? "4", 10) || 4));
  const searchFn = options?.searchFn ?? searchSerpApi;
  console.log(`[ProblemRadar/SearchOrchestrator] executing ${queriesExecuted} quer(y/ies) with bounded concurrency=${concurrency}`);

  interface TaskOutcome {
    slot: ExecSlot;
    status: SearchExecutionStatus;
    result_count: number;
    error?: string;
    latency_ms: number;
    rawItems: RawSearchItem[];
  }

  const outcomesBySlot = new Map<ExecSlot, TaskOutcome>();
  await mapWithConcurrency(slots, concurrency, async (slot) => {
    if (slot.kind !== "run") return;
    const startedAt = Date.now();
    try {
      console.log(`[ProblemRadar/SearchOrchestrator] → hypothesis="${slot.hypothesis.id}" query="${slot.query}"`);
      const rawItems = await searchFn(slot.query, { numResults: SERPAPI_CONFIG.resultsPerQuery });
      outcomesBySlot.set(slot, {
        slot,
        status: "success",
        result_count: rawItems.length,
        latency_ms: Date.now() - startedAt,
        rawItems,
      });
    } catch (error) {
      const message =
        error instanceof SerpApiError
          ? `[${error.kind}] ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      console.warn(`[ProblemRadar/SearchOrchestrator] ✗ hypothesis="${slot.hypothesis.id}" query="${slot.query}" failed after ${Date.now() - startedAt}ms: ${message}`);
      outcomesBySlot.set(slot, { slot, status: "error", result_count: 0, error: message, latency_ms: Date.now() - startedAt, rawItems: [] });
    }
  });

  // Deterministic merge — in plan order: executions and results appended in
  // slot order, with the same per-hypothesis source cap and global URL dedup
  // applied at merge time (this preserves determinism and budget accounting
  // while the HTTP calls run concurrently).
  for (const slot of slots) {
    if (slot.kind === "skip") {
      executions.push(skip(slot.hypothesis, slot.query, slot.skipStatus ?? "skipped_budget_exhausted", slot.skipReason ?? ""));
      continue;
    }
    const outcome = outcomesBySlot.get(slot)!;
    if (outcome.status === "error") {
      executions.push({
        hypothesis_id: slot.hypothesis.id,
        query: slot.query,
        status: "error",
        result_count: 0,
        error: outcome.error,
        latency_ms: outcome.latency_ms,
      });
      continue;
    }

    let keptCount = 0;
    for (const item of outcome.rawItems) {
      if (sourcesReturnedPerHypothesis[slot.hypothesis.id] >= max_sources_per_hypothesis) break;
      const canonical = canonicalizeUrl(item.link);
      if (seenCanonicalUrls.has(canonical)) continue;
      seenCanonicalUrls.add(canonical);
      results.push({
        hypothesis_id: slot.hypothesis.id,
        query: slot.query,
        title: item.title,
        url: item.link,
        snippet: item.snippet,
        source: item.source,
        position: item.position,
        published_date: item.date,
      });
      sourcesReturnedPerHypothesis[slot.hypothesis.id] += 1;
      keptCount += 1;
    }
    executions.push({
      hypothesis_id: slot.hypothesis.id,
      query: slot.query,
      status: "success",
      result_count: keptCount,
      latency_ms: outcome.latency_ms,
    });
    console.log(
      `[ProblemRadar/SearchOrchestrator] ✓ hypothesis="${slot.hypothesis.id}" query="${slot.query}" — ${outcome.rawItems.length} raw result(s), ${keptCount} kept after dedup, ${outcome.latency_ms}ms`
    );
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
