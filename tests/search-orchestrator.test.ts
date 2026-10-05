import assert from "node:assert/strict";
import test from "node:test";

import type { ResearchPlan } from "@/types";
import { runSearchOrchestrator } from "../lib/search/search-orchestrator";
import type { RawSearchItem } from "../lib/search/serpapi-client";

const DISTINCT_QUERIES = [
  "rural healthcare access barriers",
  "rural patient referral process challenges",
  "rural telehealth service limitations",
  "rural clinic staffing shortage",
  "rural hospital patient complaints",
  "rural healthcare transportation study",
];

function makePlan(searchQueriesPerHypothesis = 2): ResearchPlan {
  return {
    hypotheses: [
      {
        id: "h1", lens: "access", angle: "friction",
        hypothesis: "What barriers affect rural residents while accessing healthcare services?",
        evidence_targets: [], source_strategies: [],
        search_queries: DISTINCT_QUERIES.slice(0, searchQueriesPerHypothesis),
      },
      {
        id: "h2", lens: "workflow", angle: "workflow",
        hypothesis: "How do rural patients experience the referral process?",
        evidence_targets: [], source_strategies: [],
        search_queries: DISTINCT_QUERIES.slice(2, 2 + searchQueriesPerHypothesis),
      },
    ],
    search_budget: { max_queries_per_hypothesis: searchQueriesPerHypothesis, max_sources_per_hypothesis: 5, total_query_budget: 10 },
  };
}

function item(link: string): RawSearchItem {
  return { title: `T-${link}`, link, snippet: `snippet ${link}`, source: "example", position: 1, date: null };
}

test("independent queries execute concurrently (bounded)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const delays = [30, 30, 30, 30];
  const searchFn = async (query: string): Promise<RawSearchItem[]> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 40));
    inFlight -= 1;
    return [item(`https://example.com/${encodeURIComponent(query)}`)];
  };
  const plan = makePlan(2); // 4 queries total
  const started = Date.now();
  const run = await runSearchOrchestrator(plan, { searchFn, concurrency: 4 });
  const elapsed = Date.now() - started;
  assert.ok(maxInFlight >= 3, `expected >=3 in-flight, got ${maxInFlight}`);
  assert.ok(maxInFlight <= 4, `concurrency cap respected, got ${maxInFlight}`);
  assert.ok(elapsed < 4 * 40 + 50, `wall time ~max-path, got ${elapsed}ms`);
  assert.equal(run.results.length, 4);
  assert.equal(run.executions.filter((e) => e.status === "success").length, 4);
});

test("one timed-out/failing query does not fail the run", async () => {
  const searchFn = async (query: string): Promise<RawSearchItem[]> => {
    if (query === "rural patient referral process challenges") throw new Error("simulated SerpApi timeout");
    return [item(`https://example.com/${encodeURIComponent(query)}`)];
  };
  const run = await runSearchOrchestrator(makePlan(2), { searchFn, concurrency: 2 });
  const failed = run.executions.find((e) => e.query === "rural patient referral process challenges" && e.hypothesis_id === "h1");
  assert.equal(failed?.status, "error");
  assert.equal(run.executions.filter((e) => e.status === "success").length, 3);
  assert.equal(run.results.length, 3);
});

test("duplicate queries remain deduplicated", async () => {
  const plan = makePlan(1);
  plan.hypotheses[1].search_queries = ["rural healthcare access barriers"]; // identical to h1's only query
  let calls = 0;
  const searchFn = async (): Promise<RawSearchItem[]> => { calls += 1; return [item("https://example.com/a")]; };
  const run = await runSearchOrchestrator(plan, { searchFn, concurrency: 2 });
  assert.equal(calls, 1);
  const dup = run.executions.find((e) => e.hypothesis_id === "h2");
  assert.equal(dup?.status, "skipped_duplicate_query");
});

test("deterministic provenance ordering and traceability", async () => {
  const run = await runSearchOrchestrator(makePlan(2), {
    searchFn: async (query: string) => [item(`https://example.com/${encodeURIComponent(query)}`)],
    concurrency: 4,
  });
  const successQueries = run.executions.filter((e) => e.status === "success").map((e) => e.query);
  assert.deepEqual(successQueries, [
    "rural healthcare access barriers",
    "rural patient referral process challenges",
    "rural telehealth service limitations",
    "rural clinic staffing shortage",
  ]);
  for (const result of run.results) {
    const exec = run.executions.find((e) => e.query === result.query && e.hypothesis_id === result.hypothesis_id);
    assert.ok(exec, `result ${result.query} has a matching execution`);
    assert.ok(["h1", "h2"].includes(result.hypothesis_id));
  }
});

test("budget caps remain enforced (per-hypothesis and total)", async () => {
  const plan = makePlan(3);
  plan.search_budget.max_queries_per_hypothesis = 1;
  plan.search_budget.total_query_budget = 2;
  const run = await runSearchOrchestrator(plan, {
    searchFn: async (query: string) => [item(`https://example.com/${encodeURIComponent(query)}`)],
    concurrency: 4,
  });
  assert.equal(run.executions.filter((e) => e.status === "success").length, 2);
  assert.equal(run.budget_usage.queries_executed, 2);
  assert.ok(run.executions.filter((e) => e.status === "skipped_budget_exhausted").length >= 4);
});
