import assert from "node:assert/strict";
import test from "node:test";

import type { CandidateProblem } from "@/types";
import { buildGapQueries, runGapAnalysis } from "../lib/llm/gap-analyzer";
import type { LLMProvider } from "../lib/llm/provider";
import type { RawSearchItem } from "../lib/search/serpapi-client";

const problem: CandidateProblem = {
  id: "h1-p1",
  hypothesis_id: "h1",
  problem_statement: "Rural residents face limited access to telehealth services.",
  affected_population: "Rural residents",
  affected_activity: "Accessing telehealth services",
  context: "Broadband coverage gaps",
  mechanism: "Limited broadband prevents telehealth use",
  observed_impact: "Residents cannot use telehealth services",
  evidence_refs: [
    { evidence_id: "h1:e1", hypothesis_id: "h1", url: "https://example.org/original", query: "q", title: "T", source: "S", evidence_summary: "..." },
  ],
  evidence_strength: "strong",
};

function item(overrides: Partial<RawSearchItem> = {}): RawSearchItem {
  return {
    title: "Rural telehealth program expands access",
    link: "https://example.org/telehealth-program",
    snippet: "A nonprofit runs telehealth kiosks in rural clinics, but coverage remains limited to a few counties.",
    source: "Example News",
    position: 1,
    date: null,
    ...overrides,
  };
}

function searchReturning(items: RawSearchItem[], calls: string[] = []) {
  return async (query: string): Promise<RawSearchItem[]> => {
    calls.push(query);
    return items;
  };
}

function providerReturning(output: unknown): () => LLMProvider {
  return () => ({ name: "test", async generateJSON() { return JSON.stringify(output); } });
}

const groundedOutput = {
  existing_solutions: [
    { name: "Rural telehealth kiosk program", type: "program", description: "A nonprofit runs telehealth kiosks in rural clinics.", target_population: "rural clinic patients", evidence_indices: [1] },
  ],
  addressed_aspects: ["Telehealth access in rural clinics"],
  unresolved_gaps: [
    { gap: "Limited geographic coverage", explanation: "The kiosk program covers only a few counties, so coverage remains limited for many rural residents.", evidence_indices: [1] },
  ],
  solution_coverage: "partial",
  gap_confidence: "moderate",
};

test("candidate with solution evidence yields traceable solutions and gaps", async () => {
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(groundedOutput), search: searchReturning([item()]), concurrency: 2 });
  assert.equal(result.summary.analyzed_count, 1);
  const analysis = result.analyses[0];
  assert.equal(analysis.existing_solutions.length, 1);
  assert.equal(analysis.existing_solutions[0].evidence_refs[0].url, "https://example.org/telehealth-program");
  assert.equal(analysis.existing_solutions[0].evidence_refs[0].candidate_problem_id, "h1-p1");
  assert.equal(analysis.unresolved_gaps[0].evidence_refs[0].solution_evidence_id, "h1-p1:s1");
  assert.equal(analysis.evidence_refs.length, 1);
});

test("multiple sources describing the same solution consolidate", async () => {
  const output = {
    ...groundedOutput,
    existing_solutions: [
      { ...groundedOutput.existing_solutions[0], evidence_indices: [1] },
      { ...groundedOutput.existing_solutions[0], evidence_indices: [2] },
    ],
  };
  const items = [item(), item({ link: "https://other.org/telehealth-kiosks", title: "Telehealth kiosk program details" })];
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning(items) });
  assert.equal(result.analyses[0].existing_solutions.length, 1);
  assert.equal(result.analyses[0].existing_solutions[0].evidence_refs.length, 2);
});

test("documented limitation produces a gap", async () => {
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(groundedOutput), search: searchReturning([item()]) });
  assert.equal(result.analyses[0].unresolved_gaps.length, 1);
  assert.match(result.analyses[0].unresolved_gaps[0].gap, /coverage/i);
});

test("unsupported gap claim is rejected", async () => {
  const output = {
    ...groundedOutput,
    unresolved_gaps: [{ gap: "Rural 5G coverage falls short", explanation: "Rural 5G coverage is 40% worse across the country.", evidence_indices: [1] }],
  };
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning([item()]) });
  assert.equal(result.analyses[0].status, "failed");
  assert.equal(result.analyses[0].unresolved_gaps.length, 0);
});

test("unsupported solution is rejected", async () => {
  const output = {
    ...groundedOutput,
    existing_solutions: [{ name: "Orbital telehealth satellites", type: "technology", description: "Satellites in low orbit deliver telehealth to every rural home.", target_population: "everyone", evidence_indices: [1] }],
  };
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning([item()]) });
  assert.equal(result.analyses[0].status, "failed");
});

test('"no solution exists" style claims are never emitted', async () => {
  const output = { ...groundedOutput, existing_solutions: [], unresolved_gaps: [], solution_coverage: "insufficient_solution_evidence", addressed_aspects: [] };
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning([item()]) });
  assert.notEqual(result.analyses[0].solution_coverage, "none_exist");
  assert.doesNotMatch(JSON.stringify(result.analyses[0]), /no solution exists/i);
});

test('absolute "no solution exists" model output is rejected as invalid', async () => {
  const output = { ...groundedOutput, unresolved_gaps: [{ gap: "No solution exists", explanation: "No solution exists for rural telehealth.", evidence_indices: [1] }] };
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning([item()]) });
  assert.equal(result.analyses[0].status, "failed");
});

test("evidence references resolve to real search results and queries", async () => {
  const calls: string[] = [];
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(groundedOutput), search: searchReturning([item()], calls) });
  assert.equal(result.analyses[0].evidence_refs[0].url, "https://example.org/telehealth-program");
  assert.ok(calls.every((query) => query.toLowerCase().includes("rural") || query.toLowerCase().includes("telehealth")));
});

test("generated queries are derived from the candidate problem", () => {
  const queries = buildGapQueries(problem);
  assert.ok(queries.length > 0 && queries.length <= 5);
  assert.ok(queries.every((query) => query.toLowerCase().includes("telehealth") || query.toLowerCase().includes("rural")));
});

test("one candidate failure does not fail other candidates", async () => {
  const other: CandidateProblem = { ...problem, id: "h2-p1", problem_statement: "Rural patients wait long for clinic appointments." };
  const provider = (): LLMProvider => ({
    name: "test",
    async generateJSON({ prompt }) {
      if (prompt.includes("clinic appointments")) throw new Error("simulated LLM failure");
      return JSON.stringify(groundedOutput);
    },
  });
  const result = await runGapAnalysis([problem, other], { getProvider: provider, search: searchReturning([item()]), concurrency: 2 });
  const failed = result.analyses.find((item) => item.candidate_problem_id === "h2-p1");
  const ok = result.analyses.find((item) => item.candidate_problem_id === "h1-p1");
  assert.equal(failed?.status, "failed");
  assert.equal(ok?.status, "analyzed");
});

test("no useful search evidence means no invented solutions and no LLM call", async () => {
  let llmCalled = false;
  const provider = (): LLMProvider => ({ name: "test", async generateJSON() { llmCalled = true; return "{}"; } });
  const result = await runGapAnalysis([problem], { getProvider: provider, search: async () => [] });
  assert.equal(llmCalled, false);
  assert.equal(result.analyses[0].status, "insufficient_evidence");
  assert.equal(result.analyses[0].solution_coverage, "insufficient_solution_evidence");
  assert.equal(result.analyses[0].existing_solutions.length, 0);
});

test("multiple evidence items can support one gap", async () => {
  const output = {
    ...groundedOutput,
    unresolved_gaps: [{ gap: "Limited coverage and capacity", explanation: "Kiosks cover only a few counties and capacity in rural clinics remains limited.", evidence_indices: [1, 2] }],
  };
  const items = [item(), item({ link: "https://example.org/capacity", title: "Rural kiosk capacity", snippet: "Capacity in rural clinics remains limited." })];
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning(items) });
  assert.equal(result.analyses[0].unresolved_gaps[0].evidence_refs.length, 2);
});

test("semantic paraphrase is accepted", async () => {
  const output = {
    ...groundedOutput,
    existing_solutions: [{ name: "Telehealth kiosk nonprofit", type: "program", description: "A charity operates telemedicine kiosks serving countryside clinics.", target_population: "countryside clinic patients", evidence_indices: [1] }],
  };
  const items = [item({ title: "A charity operates telemedicine telehealth kiosks serving countryside clinics", snippet: "A charity operates telemedicine telehealth kiosks serving countryside clinics; expansion covers only a few counties and coverage remains limited." })];
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning(items) });
  assert.equal(result.analyses[0].status, "analyzed");
});

test("independent candidates execute with bounded concurrency", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const provider = (): LLMProvider => ({
    name: "test",
    async generateJSON() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return JSON.stringify({ ...groundedOutput, existing_solutions: [], unresolved_gaps: [] });
    },
  });
  const problems = [problem, { ...problem, id: "h2-p1" }, { ...problem, id: "h3-p1" }];
  await runGapAnalysis(problems, { getProvider: provider, search: searchReturning([item()]), concurrency: 3 });
  assert.ok(maxInFlight > 1, `expected concurrency, maxInFlight=${maxInFlight}`);
});

// ── Phase 4: evidence-first gap analysis ──────────────────────

/** The Phase 3 shape: a candidate carrying its validated observations and own evidence provenance. */
const problemWithObservations: CandidateProblem = {
  ...problem,
  observations: [{ claim: "Rural residents lack coverage from fixed terrestrial broadband", evidence_indices: [1] }],
};

test("the analysis prompt is anchored on the candidate's observations and provenance", async () => {
  let prompt = "";
  const provider = (): LLMProvider => ({
    name: "test",
    async generateJSON(params) {
      prompt = params.prompt;
      return JSON.stringify(groundedOutput);
    },
  });
  await runGapAnalysis([problemWithObservations], { getProvider: provider, search: searchReturning([item()]) });
  // Evidence-first: the validated observations behind the candidate...
  assert.match(prompt, /Validated observations behind the candidate/);
  assert.ok(prompt.includes("Rural residents lack coverage from fixed terrestrial broadband"));
  // ...and the candidate's own evidence provenance (what the problem IS).
  assert.match(prompt, /original evidence provenance/);
  assert.ok(prompt.includes("h1:e1"));
  assert.ok(prompt.includes("https://example.org/original"));
  // The hypothesis is never part of the evidence.
  assert.match(prompt, /the research hypothesis behind it is not supplied and is never evidence/);
});

test("queries anchor on the validated observation's friction, not broad topics", () => {
  const queries = buildGapQueries(problemWithObservations);
  assert.ok(queries.length > 0 && queries.length <= 5);
  // The observation itself leads the search...
  assert.ok(queries[0].includes("fixed terrestrial broadband"));
  // ...followed by the candidate's own statement/population/activity.
  assert.ok(queries.some((query) => query.includes("telehealth")));
  assert.ok(queries.some((query) => query.toLowerCase().includes("rural")));
});

test("every solution claim traces to its cited search evidence", async () => {
  const calls: string[] = [];
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(groundedOutput), search: searchReturning([item()], calls) });
  const solution = result.analyses[0].existing_solutions[0];
  assert.equal(solution.evidence_refs.length, 1);
  const ref = solution.evidence_refs[0];
  assert.equal(ref.candidate_problem_id, "h1-p1");
  assert.equal(ref.solution_evidence_id, "h1-p1:s1");
  assert.equal(ref.url, "https://example.org/telehealth-program");
  assert.equal(ref.query, calls[0]);
  assert.ok(ref.query.includes("telehealth"));
  assert.equal(ref.title, "Rural telehealth program expands access");
  assert.equal(ref.source, "Example News");
  assert.equal(ref.evidence_summary, "A nonprofit runs telehealth kiosks in rural clinics, but coverage remains limited to a few counties.");
});

test('unsupported "solution failure" claim is rejected', async () => {
  // The cited evidence describes a working, expanding program — no
  // failure, limitation, or gap is stated anywhere in it.
  const items = [item({ title: "Rural telehealth kiosk program", snippet: "The rural telehealth kiosk program runs clinics and expands services every year." })];
  const output = {
    ...groundedOutput,
    unresolved_gaps: [{ gap: "Kiosk program fails rural patients", explanation: "The rural telehealth kiosk program fails to serve rural clinics.", evidence_indices: [1] }],
  };
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning(items) });
  assert.equal(result.analyses[0].status, "failed");
  assert.equal(result.analyses[0].unresolved_gaps.length, 0);
});

test('a documented limitation supports a "fails to cover" gap claim', async () => {
  // The evidence states the limitation itself, so the failure claim is grounded.
  const items = [item({ title: "Rural telehealth kiosk program", snippet: "The rural telehealth kiosk program runs clinics, but coverage remains limited to a few counties." })];
  const output = {
    ...groundedOutput,
    unresolved_gaps: [{ gap: "Kiosk coverage fails to reach most rural counties", explanation: "The rural telehealth kiosk program fails to cover most rural counties because coverage remains limited.", evidence_indices: [1] }],
  };
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning(items) });
  assert.equal(result.analyses[0].status, "analyzed");
  assert.equal(result.analyses[0].unresolved_gaps.length, 1);
});

test("documented partial coverage yields a partial-coverage gap with provenance", async () => {
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(groundedOutput), search: searchReturning([item()]) });
  const analysis = result.analyses[0];
  assert.equal(analysis.solution_coverage, "partial");
  const gap = analysis.unresolved_gaps[0];
  assert.match(gap.gap, /coverage/i);
  assert.equal(gap.evidence_refs.length, 1);
  assert.equal(gap.evidence_refs[0].url, "https://example.org/telehealth-program");
  assert.equal(gap.evidence_refs[0].solution_evidence_id, "h1-p1:s1");
});

test("invented partial-coverage claim is rejected", async () => {
  // "Only wealthy urban counties" is a coverage distinction the
  // cited evidence never states — it shares enough vocabulary to
  // pass the semantic check, so the invention budget is what
  // rejects it.
  const output = {
    ...groundedOutput,
    unresolved_gaps: [{ gap: "Urban-only rollout", explanation: "The kiosk program rolled out only in wealthy urban counties and deliberately excludes rural clinics entirely.", evidence_indices: [1] }],
  };
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning([item()]) });
  assert.equal(result.analyses[0].status, "failed");
  assert.equal(result.analyses[0].unresolved_gaps.length, 0);
});

test("a candidate may legitimately end with no unresolved gap", async () => {
  const output = { ...groundedOutput, unresolved_gaps: [], solution_coverage: "clear" as const };
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(output), search: searchReturning([item()]) });
  const analysis = result.analyses[0];
  assert.equal(analysis.status, "analyzed");
  assert.equal(analysis.existing_solutions.length, 1);
  assert.equal(analysis.unresolved_gaps.length, 0);
  assert.equal(analysis.solution_coverage, "clear");
});

test("search failures leave the candidate insufficient_evidence, not failed", async () => {
  const result = await runGapAnalysis([problem], {
    getProvider: providerReturning(groundedOutput),
    search: async () => {
      throw new Error("SerpApi unavailable");
    },
  });
  const analysis = result.analyses[0];
  assert.equal(analysis.status, "insufficient_evidence");
  assert.equal(analysis.solution_coverage, "insufficient_solution_evidence");
  assert.equal(analysis.existing_solutions.length, 0);
  assert.equal(analysis.unresolved_gaps.length, 0);
  assert.ok(analysis.error?.includes("SerpApi unavailable"));
});

test("candidate and source provenance is preserved through the analysis", async () => {
  const calls: string[] = [];
  const result = await runGapAnalysis([problem], { getProvider: providerReturning(groundedOutput), search: searchReturning([item()], calls) });
  const analysis = result.analyses[0];
  // Copied verbatim from the candidate — never rewritten by this stage.
  assert.equal(analysis.problem_statement, problem.problem_statement);
  assert.equal(analysis.candidate_problem_id, problem.id);
  assert.equal(analysis.id, `${problem.id}-g1`);
  const ref = analysis.evidence_refs[0];
  assert.equal(ref.solution_evidence_id, "h1-p1:s1");
  assert.equal(ref.candidate_problem_id, problem.id);
  assert.equal(ref.url, item().link);
  assert.equal(ref.query, calls[0]);
  assert.equal(ref.title, item().title);
  assert.equal(ref.source, item().source);
  assert.equal(ref.evidence_summary, item().snippet);
});
