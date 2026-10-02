import assert from "node:assert/strict";
import test from "node:test";

import type { EvidenceAnalysisRun, ResearchPlan, SourceEvidence } from "@/types";
import { runProblemGenerator } from "../lib/llm/problem-generator";
import type { LLMProvider } from "../lib/llm/provider";

const plan: ResearchPlan = {
  hypotheses: [
    { id: "h1", lens: "access", hypothesis: "Rural clinic patients face long travel distances to care.", evidence_targets: [], source_strategies: [], search_queries: ["rural clinic travel distance"] },
    { id: "h2", lens: "availability", hypothesis: "Rural patients wait for clinic appointments.", evidence_targets: [], source_strategies: [], search_queries: ["rural clinic patient wait"] },
  ],
  search_budget: { max_queries_per_hypothesis: 2, max_sources_per_hypothesis: 5, total_query_budget: 4 },
};

function evidence(overrides: Partial<SourceEvidence> = {}): SourceEvidence {
  return {
    hypothesis_id: "h1", url: "https://example.org/clinic-report", query: "rural clinic travel distance", title: "Rural clinic distance report", source: "Example report",
    stance: "supports", relevance: "high", recency: "recent",
    evidence_summary: "Rural clinic patients travel long distances. The nearest clinic is far from villages.",
    ...overrides,
  };
}

function analysis(entries: SourceEvidence[]): EvidenceAnalysisRun {
  return {
    started_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-01-01T00:00:01.000Z", duration_ms: 1000,
    hypotheses: [
      { hypothesis_id: "h1", lens: "access", hypothesis: plan.hypotheses[0].hypothesis, status: "analyzed", evidence: entries, support_count: entries.filter((item) => item.stance === "supports").length, challenge_count: entries.filter((item) => item.stance === "challenges").length, neutral_count: entries.filter((item) => item.stance === "neutral").length },
      { hypothesis_id: "h2", lens: "availability", hypothesis: plan.hypotheses[1].hypothesis, status: "no_evidence", evidence: [], support_count: 0, challenge_count: 0, neutral_count: 0 },
    ],
  };
}

const candidate = (evidence_indices: number[] = [1]) => ({
  problem_statement: "Rural clinic patients travel long distances.",
  affected_population: "Rural clinic patients",
  affected_activity: "Traveling to clinic appointments",
  context: "Villages are far from the nearest clinic",
  mechanism: "The nearest clinic is far from villages",
  observed_impact: "Patients travel long distances",
  evidence_indices,
    observations: [{ claim: "Rural clinic patients travel long distances", evidence_indices: [1] }],
});

function providerFor(output: unknown | ((prompt: string) => unknown)): LLMProvider {
  return { name: "test", async generateJSON({ prompt }) { return JSON.stringify(typeof output === "function" ? output(prompt) : output); } };
}

test("supporting evidence generates a candidate with attached original references", async () => {
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => providerFor({ problems: [candidate()] }));
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].evidence_refs[0].url, "https://example.org/clinic-report");
  assert.equal(result.problems[0].evidence_refs[0].query, "rural clinic travel distance");
  assert.equal(result.problems[0].evidence_refs[0].evidence_id, "h1:e1");
});

test("neutral and absent evidence return no problem without resolving or calling the LLM", async () => {
  let providerResolved = false;
  const result = await runProblemGenerator(plan, analysis([evidence({ stance: "neutral" })]), () => {
    providerResolved = true;
    throw new Error("must not call");
  });
  assert.equal(providerResolved, false);
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "no_evidence");
});

test("challenging evidence is included and only supporting references can be attached", async () => {
  let prompt = "";
  const result = await runProblemGenerator(plan, analysis([
    evidence(),
    evidence({ url: "https://example.org/response", query: "clinic travel survey", stance: "challenges", relevance: "medium", evidence_summary: "Rural clinic patients report nearby clinics and short travel distances." }),
  ]), () => ({ name: "test", async generateJSON(params) { prompt = params.prompt; return JSON.stringify({ problems: [candidate()] }); } }));
  assert.match(prompt, /nearby clinics and short travel distances/);
  assert.equal(result.problems[0].evidence_refs.length, 1);
  assert.equal(result.problems[0].evidence_refs[0].url, "https://example.org/clinic-report");
});

test("duplicate evidence descriptions consolidate duplicate candidate problems and keep both references", async () => {
  const result = await runProblemGenerator(plan, analysis([
    evidence(),
    evidence({ url: "https://example.org/clinic-survey", query: "clinic distance survey", title: "Clinic distance survey" }),
  ]), () => providerFor({ problems: [candidate([1]), candidate([2])] }));
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].evidence_refs.length, 2);
});

test("unknown or challenging evidence indices fail validation and never become references", async () => {
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => providerFor({ problems: [candidate([99])] }));
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
  assert.equal(result.problems.length, 0);
});

test("invalid LLM output fails after bounded retries", async () => {
  let calls = 0;
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => ({ name: "test", async generateJSON() { calls += 1; return "not json"; } }));
  assert.equal(calls, 2);
  assert.equal(result.hypotheses[0].status, "failed");
});

test("independent hypotheses are processed with bounded concurrency", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const evidenceRun = analysis([evidence({ hypothesis_id: "h1" })]);
  evidenceRun.hypotheses[1] = {
    hypothesis_id: "h2", lens: "availability", hypothesis: plan.hypotheses[1].hypothesis, status: "analyzed",
    evidence: [evidence({ hypothesis_id: "h2", url: "https://example.org/wait", query: "rural clinic patient wait", evidence_summary: "Rural clinic patients wait long hours for appointments." })], support_count: 1, challenge_count: 0, neutral_count: 0,
  };
  const provider = (): LLMProvider => ({
    name: "test",
    async generateJSON() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return JSON.stringify({ problems: [] });
    },
  });
  const result = await runProblemGenerator(plan, evidenceRun, provider);
  assert.equal(result.problems.length, 0);
  assert.ok(maxInFlight > 1, `expected concurrent calls, maxInFlight=${maxInFlight}`);
});

test("one hypothesis failure does not prevent later hypotheses from being generated", async () => {
  let calls = 0;
  const evidenceRun = analysis([evidence()]);
  evidenceRun.hypotheses[1] = {
    hypothesis_id: "h2", lens: "availability", hypothesis: plan.hypotheses[1].hypothesis, status: "analyzed",
    evidence: [evidence({ hypothesis_id: "h2", url: "https://example.org/wait", query: "rural clinic patient wait", evidence_summary: "Rural clinic patients wait long hours for appointments." })], support_count: 1, challenge_count: 0, neutral_count: 0,
  };
  const result = await runProblemGenerator(plan, evidenceRun, () => ({ name: "test", async generateJSON() {
    calls += 1;
    if (calls === 1) throw new Error("simulated per-hypothesis provider failure");
    return JSON.stringify({ problems: [{
      problem_statement: "Rural clinic patients wait long hours for appointments.",
      affected_population: "Rural clinic patients",
      affected_activity: "Traveling to clinic appointments",
      context: "Rural clinic appointments",
      mechanism: "Patients wait long hours",
      observed_impact: "Patients wait long hours for appointments",
      evidence_indices: [1],
      observations: [{ claim: "Rural clinic patients wait long hours for appointments", evidence_indices: [1] }],
    }] });
  } }));
  assert.equal(result.hypotheses[0].status, "failed");
  assert.equal(result.hypotheses[1].status, "generated");
});

test("need for improvement does not support a claim that existing solutions fail", async () => {
  const unsupportedFailure = {
    problem_statement: "Existing telemedicine solutions fail to provide cost-effective service.",
    affected_population: "Telemedicine users",
    affected_activity: "Providing telemedicine",
    context: "Telemedicine service delivery",
    mechanism: "Existing solutions fail to provide sustainable telemedicine",
    observed_impact: "Telemedicine solutions fail to offer cost-effective service",
    evidence_indices: [1],
    observations: [{ claim: "There is a need for cost-effective and sustainable telemedicine solutions", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([evidence({ evidence_summary: "There is a need for cost-effective and sustainable telemedicine solutions." })]), () => providerFor({ problems: [unsupportedFailure] }));
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
});

test("unsupported statistics, causes, and impacts cause the candidate to be rejected", async () => {
  const unsupported = {
    ...candidate(),
    problem_statement: "Rural clinic patients miss 40% of appointments because clinics are far away.",
    mechanism: "Long travel distances cause missed appointments",
    observed_impact: "Patients miss 40% of appointments",
  };
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => providerFor({ problems: [unsupported] }));
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
});

test("regression: workforce shortage paraphrase is accepted (Case A)", async () => {
  const evidenceText = "Rural areas have difficulty recruiting and retaining healthcare workers. Physicians and nurses are in short supply in rural communities.";
  const candidateA = {
    problem_statement: "Rural healthcare facilities face significant challenges in maintaining adequate staffing levels for medical professionals.",
    affected_population: "Rural healthcare facilities",
    affected_activity: "Recruiting healthcare workers in rural areas",
    context: "Rural communities struggle to recruit and retain healthcare workers",
    mechanism: "Difficulty recruiting and retaining nurses and physicians",
    observed_impact: "Short supply of staffing for rural healthcare facilities",
    evidence_indices: [1],
    observations: [{ claim: "Rural areas have difficulty recruiting and retaining healthcare workers", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([evidence({ evidence_summary: evidenceText })]), () => providerFor({ problems: [candidateA] }));
  assert.equal(result.problems.length, 1);
});

test("regression: global outage evidence cannot become a rural-specific claim (Case B)", async () => {
  const candidateB = {
    problem_statement: "Rural areas are disproportionately affected by frequent internet outages.",
    affected_population: "Rural areas",
    affected_activity: "Accessing internet services",
    context: "Worldwide internet outages",
    mechanism: "Frequent internet outages",
    observed_impact: "Rural areas disproportionately affected",
    evidence_indices: [1],
    observations: [{ claim: "Cloudflare detected 174 major internet outages worldwide in 2025", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([evidence({ evidence_summary: "Cloudflare detected 174 major internet outages worldwide in 2025." })]), () => providerFor({ problems: [candidateB] }));
  assert.equal(result.problems.length, 0);
});

test("regression: verified-information economic-opportunity paraphrase is accepted (Case C)", async () => {
  const candidateC = {
    problem_statement: "Rural communities face challenges in accessing verified information about economic opportunities.",
    affected_population: "Rural communities",
    affected_activity: "Finding verified information on economic opportunities",
    context: "Economic opportunities in rural areas",
    mechanism: "Limited access to verified information on economic opportunities",
    observed_impact: "Rural communities struggle to find verified economic information",
    evidence_indices: [1],
    observations: [{ claim: "Rural populations struggle to find verified information on economic opportunities available to them", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([evidence({ evidence_summary: "Rural populations struggle to find verified information on economic opportunities available to them." })]), () => providerFor({ problems: [candidateC] }));
  assert.equal(result.problems.length, 1);
});

test("unsupported causal claim is rejected", async () => {
  const causal = {
    ...candidate(),
    problem_statement: "Geographic isolation causes rural healthcare worker shortages.",
    mechanism: "Geographic isolation causes rural healthcare worker shortages",
  };
  const result = await runProblemGenerator(plan, analysis([evidence({ evidence_summary: "Rural healthcare worker shortages are associated with geographic isolation." })]), () => providerFor({ problems: [causal] }));
  assert.equal(result.problems.length, 0);
});

test("combined evidence can support a synthesized statement", async () => {
  const combined = {
    ...candidate(),
    problem_statement: "Rural healthcare facilities face persistent staffing shortages.",
    affected_population: "Rural healthcare workers",
    affected_activity: "Filling nursing positions in rural areas",
    context: "Rural healthcare worker shortages",
    mechanism: "Difficulty recruiting and retaining healthcare workers",
    observed_impact: "Staffing shortages persist",
    evidence_indices: [1, 2],
    observations: [{ claim: "Rural healthcare worker shortages exist in many regions", evidence_indices: [1] }],
  };
  const sources = [
    evidence({ url: "https://example.org/a", evidence_summary: "Rural healthcare worker shortages exist in many regions." }),
    evidence({ url: "https://example.org/b", query: "rural nursing hiring", evidence_summary: "Rural areas experience difficulty filling nursing positions." }),
  ];
  const result = await runProblemGenerator(plan, analysis(sources), () => providerFor({ problems: [combined] }));
  assert.equal(result.problems.length, 1);
});

test("problem_statement that merely restates the hypothesis is rejected", async () => {
  const restatement = {
    ...candidate(),
    problem_statement: "Rural clinic patients face long travel distances to care.",
  };
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => providerFor({ problems: [restatement] }));
  assert.equal(result.problems.length, 0);
});

test("candidate with an ungrounded affected_activity is rejected", async () => {
  const ungroundedActivity = {
    ...candidate(),
    affected_activity: "Streaming live sports events",
  };
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => providerFor({ problems: [ungroundedActivity] }));
  assert.equal(result.problems.length, 0);
});

test("concrete workflow problem grounded in the evidence is accepted", async () => {
  const concrete = {
    ...candidate(),
    problem_statement: "Patients traveling to rural clinics face long distances before they can receive care.",
    affected_activity: "Traveling long distances to the nearest clinic",
  };
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => providerFor({ problems: [concrete] }));
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].affected_activity, "Traveling long distances to the nearest clinic");
});

test("broad condition without evidence of a specific activity is rejected", async () => {
  const generic = {
    problem_statement: "Rural broadband access is unreliable.",
    affected_population: "Rural residents",
    affected_activity: "General digital life",
    context: "Broadband reliability in rural areas",
    mechanism: "Broadband access is unreliable",
    observed_impact: "Connectivity is poor",
    evidence_indices: [1],
    observations: [{ claim: "Internet access is limited in some rural areas", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([evidence({ evidence_summary: "Rural broadband access is unreliable." })]), () => providerFor({ problems: [generic] }));
  assert.equal(result.problems.length, 0);
});

test("exact evidence wording is accepted", async () => {
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => providerFor({ problems: [candidate()] }));
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].observations?.length, 1);
});

test("valid paraphrase that differs from evidence wording is accepted", async () => {
  const summary = "22.3 percent of Americans in rural areas lack coverage for high-speed broadband service.";
  const paraphrase = {
    problem_statement: "A significant portion of rural Americans lack access to adequate broadband service.",
    affected_population: "Rural Americans",
    affected_activity: "Accessing broadband coverage",
    context: "Rural broadband coverage",
    mechanism: "Many rural areas lack coverage for high-speed service",
    observed_impact: "A significant portion of rural Americans have no adequate service",
    evidence_indices: [1],
    observations: [{ claim: "Rural areas lack coverage for high-speed broadband service", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([evidence({ evidence_summary: summary })]), () => providerFor({ problems: [paraphrase] }));
  assert.equal(result.problems.length, 1);
  assert.equal(result.hypotheses[0].status, "generated");
});

test("candidate combining multiple cited evidence items is accepted", async () => {
  const first = evidence({ url: "https://example.org/a", evidence_summary: "Rural internet users lose connections during telehealth appointments." });
  const second = evidence({ url: "https://example.org/b", query: "rural broadband reliability", evidence_summary: "Broadband service in rural areas is unstable and disconnects users repeatedly." });
  const combined = {
    problem_statement: "Rural telehealth users face unstable broadband that drops connections repeatedly.",
    affected_population: "Rural telehealth users",
    affected_activity: "Telehealth appointments for rural users",
    context: "Telehealth appointments in rural areas",
    mechanism: "Unstable broadband service repeatedly drops connections",
    observed_impact: "Users lose connections during appointments",
    evidence_indices: [1, 2],
    observations: [{ claim: "Rural internet users lose connections during telehealth appointments", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([first, second]), () => providerFor({ problems: [combined] }));
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].evidence_refs.length, 2);
});

test("unsupported statistic is rejected", async () => {
  const unsupported = {
    problem_statement: "Internet access is 40% slower in rural areas.",
    affected_population: "Rural residents",
    affected_activity: "Rural internet access",
    context: "Rural internet access",
    mechanism: "Rural internet is 40% slower",
    observed_impact: "Access is limited",
    evidence_indices: [1],
    observations: [{ claim: "Internet access is limited in some rural areas", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([evidence({ evidence_summary: "Internet access is limited in some rural areas." })]), () => providerFor({ problems: [unsupported] }));
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
});

test("stronger claim than the evidence supports is rejected", async () => {
  const stronger = {
    problem_statement: "All rural residents lack broadband.",
    affected_population: "All rural residents",
    affected_activity: "Accessing broadband",
    context: "Rural broadband availability",
    mechanism: "Every rural resident lacks broadband access",
    observed_impact: "All rural residents are unserved",
    evidence_indices: [1],
    observations: [{ claim: "Some rural residents lack broadband", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([evidence({ evidence_summary: "Some rural residents lack broadband." })]), () => providerFor({ problems: [stronger] }));
  assert.equal(result.problems.length, 0);
});

test("unsupported population is rejected", async () => {
  const wrongPopulation = {
    problem_statement: "Urban residents lack reliable telehealth access.",
    affected_population: "Urban residents",
    affected_activity: "Telehealth access",
    context: "Urban telehealth access",
    mechanism: "Urban areas have limited telehealth access",
    observed_impact: "Urban residents face access limits",
    evidence_indices: [1],
    observations: [{ claim: "Rural residents face limited telehealth access", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([evidence({ evidence_summary: "Rural residents face limited telehealth access." })]), () => providerFor({ problems: [wrongPopulation] }));
  assert.equal(result.problems.length, 0);
});

test("correct evidence index resolves to the correct evidence_id", async () => {
  const sources = [
    evidence({ url: "https://example.org/one", query: "q1", evidence_summary: "Rural clinic patients travel long distances." }),
    evidence({ url: "https://example.org/two", query: "q2", title: "Second", evidence_summary: "Rural clinic patients wait long hours for appointments." }),
  ];
  const second = {
    problem_statement: "Rural clinic patients wait long hours for appointments.",
    affected_population: "Rural clinic patients",
    affected_activity: "Traveling to clinic appointments",
    context: "Rural clinic appointments",
    mechanism: "Patients wait long hours",
    observed_impact: "Patients wait long hours for appointments",
    evidence_indices: [2],
    observations: [{ claim: "Rural clinic patients wait long hours for appointments", evidence_indices: [2] }],
  };
  const result = await runProblemGenerator(plan, analysis(sources), () => providerFor({ problems: [second] }));
  assert.equal(result.problems[0].evidence_refs[0].evidence_id, "h1:e2");
  assert.equal(result.problems[0].evidence_refs[0].url, "https://example.org/two");
});

test("out-of-range evidence index is rejected safely", async () => {
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => providerFor({ problems: [candidate([4])] }));
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
});

test("index pointing at challenging evidence is rejected safely", async () => {
  const result = await runProblemGenerator(plan, analysis([
    evidence(),
    evidence({ url: "https://example.org/challenge", query: "clinic survey", stance: "challenges", relevance: "medium", evidence_summary: "Rural clinics are nearby for most patients." }),
  ]), () => providerFor({ problems: [candidate([2])] }));
  assert.equal(result.problems.length, 0);
});

test("no supporting evidence means no LLM call", async () => {
  let called = false;
  const result = await runProblemGenerator(plan, analysis([]), () => ({ name: "test", async generateJSON() { called = true; return "{}"; } }));
  assert.equal(called, false);
  assert.equal(result.hypotheses[0].status, "no_evidence");
});

test("duplicate problems are consolidated", async () => {
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => providerFor({ problems: [candidate([1]), candidate([1])] }));
  assert.equal(result.problems.length, 1);
});

test("semantic rephrasings of a telehealth connectivity problem consolidate and keep both references", async () => {
  const first = evidence({
    url: "https://example.org/connectivity-one",
    evidence_summary: "Rural internet users lose connections during telehealth appointments. Broadband service is unreliable.",
  });
  const second = evidence({
    url: "https://example.org/connectivity-two", query: "rural remote medical visit internet interruptions",
    evidence_summary: "During remote medical visits in rural areas, unstable internet repeatedly disconnects users.",
  });
  const firstCandidate = {
    problem_statement: "Rural internet users lose connections during telehealth appointments.",
    affected_population: "Rural internet users",
    affected_activity: "Telehealth appointments",
    context: "During telehealth appointments",
    mechanism: "Broadband service is unreliable",
    observed_impact: "Users lose connections",
    evidence_indices: [1],
    observations: [{ claim: "Rural internet users lose connections during telehealth appointments", evidence_indices: [1] }],
  };
  const secondCandidate = {
    problem_statement: "Remote medical visits have unstable internet and disconnected users.",
    affected_population: "Users in rural areas",
    affected_activity: "Remote medical visits",
    context: "During remote medical visits",
    mechanism: "Unstable internet",
    observed_impact: "Users disconnect repeatedly",
    evidence_indices: [2],
    observations: [{ claim: "During remote medical visits in rural areas, unstable internet repeatedly disconnects users", evidence_indices: [2] }],
  };
  const result = await runProblemGenerator(plan, analysis([first, second]), () => providerFor({ problems: [firstCandidate, secondCandidate] }));
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].evidence_refs.length, 2);
});

test("distinct education problems in the same domain remain separate", async () => {
  const source = evidence({ evidence_summary: "Rural schools lack learning resources. Teachers lack inclusive education training in rural classrooms." });
  const resources = {
    problem_statement: "Rural schools lack learning resources.", affected_population: "Rural schools", affected_activity: "Learning in rural schools",
    context: "Learning resources in rural schools", mechanism: "Schools lack learning resources",
    observed_impact: "Rural schools lack learning resources", evidence_indices: [1], observations: [{ claim: "Rural schools lack learning resources", evidence_indices: [1] }],
  };
  const training = {
    problem_statement: "Teachers lack inclusive education training.", affected_population: "Teachers", affected_activity: "Inclusive education training",
    context: "Inclusive education in rural classrooms", mechanism: "Teachers lack inclusive education training",
    observed_impact: "Teachers lack inclusive education training", evidence_indices: [1], observations: [{ claim: "Teachers lack inclusive education training", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([source]), () => providerFor({ problems: [resources, training] }));
  assert.equal(result.problems.length, 2);
});

test("consolidated evidence references are original, unique, and supporting", async () => {
  const sources = [
    evidence({ url: "https://example.org/a" }),
    evidence({ url: "https://example.org/b", query: "clinic distance survey" }),
    evidence({ url: "https://example.org/c", query: "clinic distance challenge", stance: "challenges", relevance: "medium", evidence_summary: "Rural clinic patients report nearby clinics and short travel distances." }),
  ];
  const result = await runProblemGenerator(plan, analysis(sources), () => providerFor({ problems: [candidate([1]), candidate([2])] }));
  assert.equal(result.problems.length, 1);
  assert.deepEqual(result.problems[0].evidence_refs.map((ref) => ref.evidence_id).sort(), ["h1:e1", "h1:e2"]);
  assert.ok(result.problems[0].evidence_refs.every((ref) => ref.url !== "https://example.org/c"));
});
