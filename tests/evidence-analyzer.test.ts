import assert from "node:assert/strict";
import test from "node:test";

import type { LLMProvider } from "../lib/llm/provider";
import { runEvidenceAnalyzer } from "../lib/llm/evidence-analyzer";
import type { ResearchPlan, SearchRun, SearchResult } from "@/types";

const plan: ResearchPlan = {
  hypotheses: [
    { id: "h1", lens: "access", angle: "friction", hypothesis: "What barriers affect rural residents while accessing healthcare services?", evidence_targets: [], source_strategies: [], search_queries: ["q1"] },
  ],
  search_budget: { max_queries_per_hypothesis: 2, max_sources_per_hypothesis: 5, total_query_budget: 4 },
};

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    hypothesis_id: "h1", query: "rural healthcare access barriers", title: "Rural clinic distance report", url: "https://example.org/clinic",
    snippet: "Rural patients may travel long distances to receive specialist care.", source: "Example report", position: 1, published_date: null,
    ...overrides,
  };
}

function runWith(results: SearchResult[]): SearchRun {
  return {
    started_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-01-01T00:00:01.000Z", duration_ms: 1000,
    executions: [{ hypothesis_id: "h1", query: "rural healthcare access barriers", status: "success", result_count: results.length, latency_ms: 10 }],
    results,
    budget_usage: { total_query_budget: 4, max_queries_per_hypothesis: 2, max_sources_per_hypothesis: 5, queries_executed: 1, queries_skipped_duplicate: 0, queries_skipped_budget: 0, sources_returned_per_hypothesis: { h1: results.length } },
  };
}

function providerReturning(output: unknown): () => LLMProvider {
  return () => ({ name: "test", async generateJSON() { return JSON.stringify(output); } });
}

const validEntry = {
  source_index: 1,
  stance: "supports",
  relevance: "high",
  evidence_summary: "Rural patients may travel long distances to receive specialist care.",
  observations: [
    {
      observation: "Rural patients may travel long distances to receive specialist care.",
      affected_group: "rural patients",
      activity: "accessing specialist care",
      friction: "travel distance",
      workaround: null,
      existing_solution: null,
      unresolved_signal: null,
    },
  ],
};

test("valid observation extraction with full provenance", async () => {
  const results = [result()];
  const analysis = await runEvidenceAnalyzer(plan, runWith(results), providerReturning({ evidence: [validEntry] }));
  const entry = analysis.hypotheses[0].evidence[0];
  assert.equal(entry.url, "https://example.org/clinic");
  assert.equal(entry.query, "rural healthcare access barriers");
  assert.equal(entry.stance, "supports");
  assert.equal(entry.observations?.length, 1);
  assert.equal(entry.observations?.[0].affected_group, "rural patients");
  assert.equal(entry.observations?.[0].activity, "accessing specialist care");
  assert.equal(entry.observations?.[0].friction, "travel distance");
  assert.equal(entry.observations?.[0].source_index, 1);
});

test("optional fields remain null when the source does not establish them", async () => {
  const results = [result()];
  const analysis = await runEvidenceAnalyzer(plan, runWith(results), providerReturning({ evidence: [validEntry] }));
  const obs = analysis.hypotheses[0].evidence[0].observations?.[0];
  assert.equal(obs?.workaround, null);
  assert.equal(obs?.existing_solution, null);
  assert.equal(obs?.unresolved_signal, null);
});

test("optional fields omitted entirely by the model are normalized to null", async () => {
  // The live model routinely drops null-valued keys instead of emitting them.
  const entryWithAbsentFields = {
    ...validEntry,
    observations: [
      {
        observation: "Rural patients may travel long distances to receive specialist care.",
        affected_group: "rural patients",
        activity: "accessing specialist care",
        friction: "travel distance",
        // workaround / existing_solution / unresolved_signal all absent
      },
    ],
  };
  const analysis = await runEvidenceAnalyzer(plan, runWith([result()]), providerReturning({ evidence: [entryWithAbsentFields] }));
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  const obs = analysis.hypotheses[0].evidence[0].observations?.[0];
  assert.equal(obs?.workaround, null);
  assert.equal(obs?.existing_solution, null);
  assert.equal(obs?.unresolved_signal, null);
});

test("unsupported observation (invented detail) is rejected without discarding valid observations", async () => {
  // Scoped rejection: the invented statistic's observation is dropped,
  // the supported one beside it survives.
  const mixed = {
    ...validEntry,
    observations: [validEntry.observations[0], { ...validEntry.observations[0], friction: "travel distance and 40% higher costs" }],
  };
  const analysis = await runEvidenceAnalyzer(plan, runWith([result()]), providerReturning({ evidence: [mixed] }));
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  const observations = analysis.hypotheses[0].evidence[0].observations ?? [];
  assert.equal(observations.length, 1);
  assert.equal(observations[0].friction, "travel distance");
});

test("unsupported causation in an observation is rejected", async () => {
  const bad = {
    ...validEntry,
    observations: [{ ...validEntry.observations[0], observation: "Long travel distances cause rural patients to miss specialist care." }],
  };
  const analysis = await runEvidenceAnalyzer(plan, runWith([result()]), providerReturning({ evidence: [bad] }));
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  assert.deepEqual(analysis.hypotheses[0].evidence[0].observations, []);
});

test("unsupported population in an observation is rejected", async () => {
  const bad = {
    ...validEntry,
    observations: [{ ...validEntry.observations[0], affected_group: "urban patients" }],
  };
  const analysis = await runEvidenceAnalyzer(plan, runWith([result()]), providerReturning({ evidence: [bad] }));
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  assert.deepEqual(analysis.hypotheses[0].evidence[0].observations, []);
});

test("unsupported statistic in an observation is rejected", async () => {
  const bad = {
    ...validEntry,
    observations: [{ ...validEntry.observations[0], observation: "Rural patients travel 40% farther to receive specialist care." }],
  };
  const analysis = await runEvidenceAnalyzer(plan, runWith([result()]), providerReturning({ evidence: [bad] }));
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  assert.deepEqual(analysis.hypotheses[0].evidence[0].observations, []);
});

test("unsupported evidence_summary still fails the whole hypothesis", async () => {
  // Pre-existing behavior, deliberately unchanged: observations are
  // isolated, summaries are not.
  const bad = { ...validEntry, evidence_summary: "Regional clinics report a sudden 30% rise in patient wait times." };
  const analysis = await runEvidenceAnalyzer(plan, runWith([result()]), providerReturning({ evidence: [bad] }));
  assert.equal(analysis.hypotheses[0].status, "failed");
  assert.match(analysis.hypotheses[0].error ?? "", /doesn't ground/);
});

test("invalid source index is rejected", async () => {
  const bad = { ...validEntry, source_index: 99 };
  const analysis = await runEvidenceAnalyzer(plan, runWith([result()]), providerReturning({ evidence: [bad] }));
  assert.equal(analysis.hypotheses[0].status, "failed");
});

test("challenging evidence is retained with its observations", async () => {
  const challenging = {
    ...validEntry,
    stance: "challenges",
    observations: [{ ...validEntry.observations[0], unresolved_signal: "specialist care remains out of reach" }],
  };
  const analysis = await runEvidenceAnalyzer(plan, runWith([result()]), providerReturning({ evidence: [challenging] }));
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  assert.equal(analysis.hypotheses[0].challenge_count, 1);
  assert.equal(analysis.hypotheses[0].evidence[0].observations?.[0].unresolved_signal, "specialist care remains out of reach");
});

test("neutral evidence is retained", async () => {
  const neutral = { ...validEntry, stance: "neutral", observations: [] };
  const analysis = await runEvidenceAnalyzer(plan, runWith([result()]), providerReturning({ evidence: [neutral] }));
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  assert.equal(analysis.hypotheses[0].neutral_count, 1);
  assert.deepEqual(analysis.hypotheses[0].evidence[0].observations, []);
});

test("one hypothesis failure does not prevent other hypotheses from being analyzed", async () => {
  const twoHypotheses: ResearchPlan = {
    ...plan,
    hypotheses: [
      plan.hypotheses[0],
      { id: "h2", lens: "cost", angle: "research", hypothesis: "What does research say about rural healthcare costs?", evidence_targets: [], source_strategies: [], search_queries: ["q2"] },
    ],
  };
  const results = [result(), result({ hypothesis_id: "h2", query: "rural healthcare costs", url: "https://example.org/costs", title: "Cost study", snippet: "A survey of rural healthcare costs." })];
  const provider = (): LLMProvider => ({
    name: "test",
    async generateJSON({ prompt }) {
      if (prompt.includes("barriers")) throw new Error("simulated provider failure");
      return JSON.stringify({ evidence: [{ source_index: 1, stance: "supports", relevance: "medium", evidence_summary: "A survey of rural healthcare costs.", observations: [] }] });
    },
  });
  const analysis = await runEvidenceAnalyzer(twoHypotheses, runWith(results), provider);
  assert.equal(analysis.hypotheses[0].status, "failed");
  assert.equal(analysis.hypotheses[1].status, "analyzed");
});

test("observation field grounded via inflection variant of the source wording is accepted", async () => {
  // Source pluralizes where the field singularizes — same supported fact.
  const results = [
    result({
      title: "rural infrastructure and economic development",
      snippet:
        "Failure to accelerate investments in rural infrastructure will make a mockery of efforts to achieve the Millennium Development Goals in poor developing areas.",
    }),
  ];
  const entry = {
    source_index: 1,
    stance: "supports",
    relevance: "high",
    evidence_summary:
      "Failure to accelerate investments in rural infrastructure will make a mockery of efforts to achieve the Millennium Development Goals in poor developing areas.",
    observations: [
      {
        observation:
          "Failure to accelerate investments in rural infrastructure will make a mockery of efforts to achieve the Millennium Development Goals in poor developing areas.",
        affected_group: null,
        activity: null,
        friction: "lack of investment",
        workaround: null,
        existing_solution: null,
        unresolved_signal: null,
      },
    ],
  };
  const analysis = await runEvidenceAnalyzer(plan, runWith(results), providerReturning({ evidence: [entry] }));
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  assert.equal(analysis.hypotheses[0].evidence[0].observations?.[0].friction, "lack of investment");
});

test("observation field grounded via derivational variant of the source wording is accepted", async () => {
  // Source says "transport infrastructure"; the field says "transportation".
  const results = [
    result({
      title: "Rural Transport Challenges and Solutions",
      snippet: "Rural transport infrastructure is inadequate, limiting socioeconomic development and integration.",
    }),
  ];
  const entry = {
    source_index: 1,
    stance: "supports",
    relevance: "high",
    evidence_summary: "Rural transport infrastructure is inadequate, limiting socioeconomic development and integration.",
    observations: [
      {
        observation: "Rural transport infrastructure is inadequate, limiting socioeconomic development and integration.",
        affected_group: null,
        activity: "transportation",
        friction: null,
        workaround: null,
        existing_solution: null,
        unresolved_signal: null,
      },
    ],
  };
  const analysis = await runEvidenceAnalyzer(plan, runWith(results), providerReturning({ evidence: [entry] }));
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  assert.equal(analysis.hypotheses[0].evidence[0].observations?.[0].activity, "transportation");
});

test("observation field whose concept is absent from the source is still rejected", async () => {
  // The source discusses learners/digital divide but never education itself.
  const results = [
    result({
      title: "(PDF) Bridging the Knowledge Gap: Countering the Digital Divide",
      snippet:
        "The digital divide between urban and rural learners is a significant obstacle to achieving the United Nations Sustainable Development Goal.",
    }),
  ];
  const entry = {
    source_index: 1,
    stance: "supports",
    relevance: "medium",
    evidence_summary:
      "The digital divide between urban and rural learners is a significant obstacle to achieving the United Nations Sustainable Development Goal.",
    observations: [
      {
        observation:
          "The digital divide between urban and rural learners is a significant obstacle to achieving the United Nations Sustainable Development Goal.",
        affected_group: "rural learners",
        activity: "education",
        friction: null,
        workaround: null,
        existing_solution: null,
        unresolved_signal: null,
      },
    ],
  };
  const analysis = await runEvidenceAnalyzer(plan, runWith(results), providerReturning({ evidence: [entry] }));
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  assert.deepEqual(analysis.hypotheses[0].evidence[0].observations, []);
});

test("validation failure is fed back to the model on retry", async () => {
  const prompts: string[] = [];
  const provider = (): LLMProvider => ({
    name: "test",
    async generateJSON({ prompt }) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        // Attempt 1 summarizes something the source never says.
        return JSON.stringify({
          evidence: [{ ...validEntry, evidence_summary: "Regional clinics report a sudden 30% rise in patient wait times." }],
        });
      }
      // Attempt 2 corrects it.
      return JSON.stringify({ evidence: [validEntry] });
    },
  });
  const analysis = await runEvidenceAnalyzer(plan, runWith([result()]), provider);
  assert.equal(analysis.hypotheses[0].status, "analyzed");
  assert.equal(prompts.length, 2, "expected a retry after the rejected attempt");
  assert.match(prompts[1], /previous attempt was rejected by validation/);
  assert.match(prompts[1], /doesn't ground/);
});

test("short-token observation fields ground only when literally present", async () => {
  const observation = {
    observation: "Rural students rely on DSL internet where fiber is unavailable.",
    affected_group: "rural students",
    activity: "relying on DSL internet",
    friction: null,
    workaround: null,
    existing_solution: "DSL",
    unresolved_signal: null,
  };

  // Source really does contain "DSL" -> grounds.
  const withDsl = [
    result({ snippet: "Rural students rely on DSL internet where fiber is unavailable.", title: "Rural connectivity notes" }),
  ];
  const entryWithDsl = {
    source_index: 1,
    stance: "supports",
    relevance: "high",
    evidence_summary: "Rural students rely on DSL internet where fiber is unavailable.",
    observations: [observation],
  };
  const accepted = await runEvidenceAnalyzer(plan, runWith(withDsl), providerReturning({ evidence: [entryWithDsl] }));
  assert.equal(accepted.hypotheses[0].status, "analyzed");
  assert.equal(accepted.hypotheses[0].evidence[0].observations?.[0].existing_solution, "DSL");

  // Different source, no "DSL" anywhere -> still rejected.
  const withoutDsl = {
    ...validEntry,
    observations: [{ ...validEntry.observations[0], existing_solution: "DSL" }],
  };
  const rejected = await runEvidenceAnalyzer(plan, runWith([result()]), providerReturning({ evidence: [withoutDsl] }));
  assert.equal(rejected.hypotheses[0].status, "analyzed");
  assert.deepEqual(rejected.hypotheses[0].evidence[0].observations, []);
});
