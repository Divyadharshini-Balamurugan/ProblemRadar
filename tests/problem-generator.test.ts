import assert from "node:assert/strict";
import test from "node:test";

import type { EvidenceAnalysisRun, EvidenceObservation, ResearchPlan, SourceEvidence } from "@/types";
import { runProblemGenerator } from "../lib/llm/problem-generator";
import type { LLMProvider } from "../lib/llm/provider";

const plan: ResearchPlan = {
  hypotheses: [
    { id: "h1", lens: "access", angle: "friction", hypothesis: "What travel distances do rural clinic patients face to reach care?", evidence_targets: [], source_strategies: [], search_queries: ["rural clinic travel distance"] },
    { id: "h2", lens: "availability", angle: "workflow", hypothesis: "How do rural patients experience waiting for clinic appointments?", evidence_targets: [], source_strategies: [], search_queries: ["rural clinic patient wait"] },
  ],
  search_budget: { max_queries_per_hypothesis: 2, max_sources_per_hypothesis: 5, total_query_budget: 4 },
};

/** One validated (Phase 2) observation; optional fields stay null unless a fixture establishes them. */
function observation(
  text: string,
  sourceIndex = 1,
  fields: Partial<Omit<EvidenceObservation, "observation" | "source_index">> = {}
): EvidenceObservation {
  return {
    observation: text,
    affected_group: null,
    activity: null,
    friction: null,
    workaround: null,
    existing_solution: null,
    unresolved_signal: null,
    source_index: sourceIndex,
    ...fields,
  };
}

function evidence(overrides: Partial<SourceEvidence> = {}): SourceEvidence {
  const base: SourceEvidence = {
    hypothesis_id: "h1", url: "https://example.org/clinic-report", query: "rural clinic travel distance", title: "Rural clinic distance report", source: "Example report",
    stance: "supports", relevance: "high", recency: "recent",
    evidence_summary: "Rural clinic patients travel long distances. The nearest clinic is far from villages.",
    ...overrides,
  };
  return {
    ...base,
    // The generator consumes validated observations, so every fixture carries
    // one mirroring its own summary (what the Evidence Analyzer produces).
    // Tests opt out with an explicit `observations: []`.
    observations: overrides.observations ?? [observation(base.evidence_summary)],
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

/** Both hypotheses analyzed with their own sources — the setup where cross-hypothesis observation borrowing applies. */
function analysisTwo(first: SourceEvidence[], second: SourceEvidence[]): EvidenceAnalysisRun {
  const run = analysis(first);
  run.hypotheses[1] = {
    hypothesis_id: "h2",
    lens: "availability",
    hypothesis: plan.hypotheses[1].hypothesis,
    status: "analyzed",
    evidence: second,
    support_count: second.filter((item) => item.stance === "supports").length,
    challenge_count: second.filter((item) => item.stance === "challenges").length,
    neutral_count: second.filter((item) => item.stance === "neutral").length,
  };
  return run;
}

const candidate = (evidence_indices: number[] = [1]) => ({
  problem_statement: "Rural clinic patients travel long distances.",
  affected_population: "Rural clinic patients",
  affected_activity: "Traveling to clinic appointments",
  context: "Villages are far from the nearest clinic",
  mechanism: "The nearest clinic is far from villages",
  observed_impact: "Patients travel long distances",
  evidence_indices,
    observations: [{ claim: "Rural clinic patients travel long distances", evidence_indices }],
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
    observations: [{ claim: "Rural healthcare worker shortages are associated with geographic isolation", evidence_indices: [1] }],
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
    evidence({ url: "https://example.org/b", query: "rural nursing hiring", evidence_summary: "Rural healthcare facilities experience difficulty filling nursing positions." }),
  ];
  const result = await runProblemGenerator(plan, analysis(sources), () => providerFor({ problems: [combined] }));
  assert.equal(result.problems.length, 1);
});

test("problem_statement that merely restates the hypothesis is rejected", async () => {
  const restatement = {
    ...candidate(),
    problem_statement: "What travel distances do rural clinic patients face to reach care?",
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

/** Provider that captures the prompt so tests can inspect what the model was actually given. */
function capturingProvider(output: unknown, captured: { prompt: string }): LLMProvider {
  return {
    name: "test",
    async generateJSON(params) {
      captured.prompt = params.prompt;
      return JSON.stringify(output);
    },
  };
}

// ── Phase 3: observation → pattern → candidate ──────────────────────────────

test("valid observation → problem: validated observations drive the prompt and the candidate", async () => {
  const source = evidence({
    evidence_summary: "Residents in villages wait for hours to see a nurse at the health post.",
    observations: [
      observation("Residents in villages wait for hours to see a nurse at the health post.", 1, {
        affected_group: "Residents in villages",
        activity: "Seeing a nurse at the health post",
        friction: "waiting for hours",
        unresolved_signal: "long waits remain unaddressed",
      }),
    ],
  });
  const captured: { prompt: string } = { prompt: "" };
  const result = await runProblemGenerator(plan, analysis([source]), () => capturingProvider({ problems: [{
    problem_statement: "Village residents wait for hours to see a nurse at the health post.",
    affected_population: "Residents in villages",
    affected_activity: "Seeing a nurse at the health post",
    context: "Health posts in villages",
    mechanism: "Residents wait for hours to see a nurse",
    observed_impact: "Residents wait for hours",
    evidence_indices: [1],
    observations: [{ claim: "Residents in villages wait for hours to see a nurse at the health post", evidence_indices: [1] }],
  }] }, captured));

  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].affected_activity, "Seeing a nurse at the health post");
  // The prompt is observation-first: the hypothesis is context, the validated
  // observation (with its structured fields) is the basis, and the internal
  // three-step pattern flow is spelled out.
  assert.match(captured.prompt, /Research hypothesis \(context only — it is NOT evidence/);
  assert.match(captured.prompt, /Validated observations from supporting sources — the ONLY basis/);
  assert.match(captured.prompt, /validated observation: "Residents in villages wait for hours/);
  assert.match(captured.prompt, /activity: "Seeing a nurse at the health post"/);
  assert.match(captured.prompt, /unresolved signal: "long waits remain unaddressed"/);
  assert.match(captured.prompt, /1\) PATTERN:/);
  assert.match(captured.prompt, /3\) CANDIDATE:/);
  assert.ok(captured.prompt.indexOf("validated observation") < captured.prompt.indexOf("1) PATTERN:"));
});

test("multi-observation grounded synthesis: two observations of one pattern become one claim", async () => {
  const source = evidence({
    evidence_summary: "Rural clinics struggle to recruit doctors and retain nurses.",
    observations: [
      observation("Rural clinics struggle to recruit doctors.", 1),
      observation("Rural clinics struggle to retain nurses.", 1),
    ],
  });
  const combined = {
    problem_statement: "Rural clinics struggle to recruit and retain medical staff.",
    affected_population: "Rural clinics",
    affected_activity: "Recruiting and retaining medical staff",
    context: "Staffing at rural clinics",
    mechanism: "Rural clinics struggle to recruit and retain medical staff",
    observed_impact: "Rural clinics struggle to retain staff",
    evidence_indices: [1],
    observations: [{ claim: "Rural clinics struggle to recruit and retain medical staff", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([source]), () => providerFor({ problems: [combined] }));
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].evidence_refs.length, 1);
});

test("valid multi-source synthesis keeps every cited source's provenance", async () => {
  const first = evidence({ url: "https://example.org/staffing-a", query: "rural doctor shortage", evidence_summary: "Rural health facilities cannot recruit enough doctors." });
  const second = evidence({ url: "https://example.org/staffing-b", query: "rural nurse retention", evidence_summary: "Rural health facilities lose nurses who relocate to cities." });
  const captured: { prompt: string } = { prompt: "" };
  const synthesized = {
    problem_statement: "Rural health facilities cannot recruit and retain doctors and nurses.",
    affected_population: "Rural health facilities",
    affected_activity: "Recruiting and retaining doctors and nurses",
    context: "Staffing at rural health facilities",
    mechanism: "Rural health facilities cannot recruit doctors and lose nurses",
    observed_impact: "Rural health facilities lose staff",
    evidence_indices: [1, 2],
    observations: [{ claim: "Rural health facilities cannot recruit and retain doctors and nurses", evidence_indices: [1, 2] }],
  };
  const result = await runProblemGenerator(plan, analysis([first, second]), () => capturingProvider({ problems: [synthesized] }, captured));

  assert.equal(result.problems.length, 1);
  const refs = result.problems[0].evidence_refs;
  assert.deepEqual(refs.map((ref) => ref.url).sort(), ["https://example.org/staffing-a", "https://example.org/staffing-b"]);
  assert.deepEqual(refs.map((ref) => ref.evidence_id).sort(), ["h1:e1", "h1:e2"]);
  // Both validated observations were presented to the model as the pattern's basis.
  assert.match(captured.prompt, /validated observation: "Rural health facilities cannot recruit enough doctors/);
  assert.match(captured.prompt, /validated observation: "Rural health facilities lose nurses/);
});

test("intact provenance: claim → validated observation → evidence ref → original source", async () => {
  const source = evidence({
    url: "https://example.org/referral",
    query: "rural patient referral delays",
    title: "Referral delays in rural clinics",
    source: "Rural Health Journal",
    evidence_summary: "Patients at rural clinics wait for referrals that never arrive.",
    observations: [
      observation("Patients at rural clinics wait for referrals that never arrive.", 1, {
        activity: "Waiting for a referral",
        friction: "referrals that never arrive",
      }),
    ],
  });
  const captured: { prompt: string } = { prompt: "" };
  const result = await runProblemGenerator(plan, analysis([source]), () => capturingProvider({ problems: [{
    problem_statement: "Patients at rural clinics wait for referrals that never arrive.",
    affected_population: "Patients at rural clinics",
    affected_activity: "Waiting for a referral",
    context: "Referrals at rural clinics",
    mechanism: "Referrals that never arrive",
    observed_impact: "Patients wait for referrals",
    evidence_indices: [1],
    observations: [{ claim: "Patients at rural clinics wait for referrals that never arrive", evidence_indices: [1] }],
  }] }, captured));

  const problem = result.problems[0];
  assert.equal(problem.hypothesis_id, "h1");
  assert.deepEqual(problem.observations, [{ claim: "Patients at rural clinics wait for referrals that never arrive", evidence_indices: [1] }]);
  const ref = problem.evidence_refs[0];
  assert.equal(ref.evidence_id, "h1:e1");
  assert.equal(ref.hypothesis_id, "h1");
  assert.equal(ref.url, "https://example.org/referral");
  assert.equal(ref.query, "rural patient referral delays");
  assert.equal(ref.title, "Referral delays in rural clinics");
  assert.equal(ref.source, "Rural Health Journal");
  assert.equal(ref.evidence_summary, "Patients at rural clinics wait for referrals that never arrive.");
  // The claim traces to the validated observation that was actually shown.
  assert.ok(captured.prompt.includes('"Patients at rural clinics wait for referrals that never arrive."'));
});

test("a claim citing evidence the candidate does not cite is rejected", async () => {
  const sources = [
    evidence({ url: "https://example.org/one", query: "q1" }),
    evidence({ url: "https://example.org/two", query: "q2", evidence_summary: "Rural clinic patients travel long distances to reach the health post." }),
  ];
  const straying = {
    ...candidate([1]),
    observations: [{ claim: "Rural clinic patients travel long distances to reach the health post", evidence_indices: [2] }],
  };
  const result = await runProblemGenerator(plan, analysis(sources), () => providerFor({ problems: [straying] }));
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
});

test("unsupported observed impact is rejected", async () => {
  const source = evidence({
    evidence_summary: "Residents report difficulty booking clinic appointments by phone.",
    observations: [observation("Residents report difficulty booking clinic appointments by phone.")],
  });
  const unsupportedImpact = {
    problem_statement: "Residents report difficulty booking clinic appointments by phone.",
    affected_population: "Residents",
    affected_activity: "Booking clinic appointments by phone",
    context: "Phone booking at the clinic",
    mechanism: "Residents report difficulty booking appointments",
    observed_impact: "Patients delay treatment and their conditions worsen",
    evidence_indices: [1],
    observations: [{ claim: "Residents report difficulty booking clinic appointments by phone", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([source]), () => providerFor({ problems: [unsupportedImpact] }));
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
});

test("weak observations yield no candidate instead of a forced generic problem", async () => {
  const source = evidence({
    evidence_summary: "The article lists rural development as an important topic for the region.",
    observations: [observation("The article lists rural development as an important topic for the region.")],
  });
  let calls = 0;
  const forced = {
    problem_statement: "Villagers must walk for hours to reach a doctor when someone falls ill.",
    affected_population: "Villagers",
    affected_activity: "Walking to a doctor when someone falls ill",
    context: "Remote villages without transport",
    mechanism: "No roads connect the villages to the clinic",
    observed_impact: "Villagers walk for hours and delay care",
    evidence_indices: [1],
    observations: [{ claim: "The article lists rural development as an important topic for the region", evidence_indices: [1] }],
  };
  const result = await runProblemGenerator(plan, analysis([source]), () => ({ name: "test", async generateJSON() { calls += 1; return JSON.stringify({ problems: [forced] }); } }));
  assert.equal(calls, 1);
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
});

test("hypothesis alone cannot create a problem: no validated observations means no model call", async () => {
  let called = false;
  const result = await runProblemGenerator(plan, analysis([evidence({ observations: [] })]), () => ({
    name: "test",
    async generateJSON() {
      called = true;
      return JSON.stringify({ problems: [candidate()] });
    },
  }));
  assert.equal(called, false);
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
  // The supporting evidence is there — only the validated observations are missing.
  assert.equal(result.hypotheses[0].supporting_evidence_count, 1);
});

test("unrelated observations are not forcibly combined into one candidate", async () => {
  const schools = evidence({ url: "https://example.org/schools", query: "rural school learning resources", evidence_summary: "Rural schools lack learning resources for students." });
  const clinics = evidence({ url: "https://example.org/clinics", query: "rural clinic travel distance", evidence_summary: "Rural clinic patients travel long distances to receive care." });
  const mashup = {
    problem_statement: "Rural students who need clinic care also lack school learning resources.",
    affected_population: "Rural students",
    affected_activity: "Studying at school and visiting the clinic",
    context: "Rural schools and clinics",
    mechanism: "Schools lack learning resources while patients travel long distances",
    observed_impact: "Students lack resources and patients travel far",
    evidence_indices: [1, 2],
    observations: [{ claim: "Rural students who need clinic care also lack school learning resources", evidence_indices: [1, 2] }],
  };
  const result = await runProblemGenerator(plan, analysis([schools, clinics]), () => providerFor({ problems: [mashup] }));
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
});

test("semantic deduplication runs only after invalid candidates are rejected", async () => {
  const unsupported = {
    ...candidate(),
    problem_statement: "Rural clinics bill patients 90% of their income.",
    mechanism: "Clinics charge patients 90% of their income",
    observed_impact: "Patients pay 90% of their income",
  };
  const result = await runProblemGenerator(plan, analysis([evidence()]), () => providerFor({
    problems: [candidate(), unsupported, { ...candidate(), problem_statement: "Rural clinic patients travel long distances." }],
  }));
  // The unsupported candidate never reaches deduplication...
  assert.equal(result.hypotheses[0].problems_before_deduplication_count, 2);
  // ...and the two valid semantic duplicates merge into one.
  assert.equal(result.problems.length, 1);
});

test("the hypothesis is presented as context only, never as evidence", async () => {
  const captured: { prompt: string } = { prompt: "" };
  await runProblemGenerator(plan, analysis([evidence()]), () => capturingProvider({ problems: [] }, captured));
  assert.match(captured.prompt, /Research hypothesis \(context only — it is NOT evidence and never establishes that a problem exists\)/);
  assert.match(captured.prompt, /never to the hypothesis/);
  assert.doesNotMatch(captured.prompt, /Supporting evidence \(the only basis/);
});

// ── Phase 3 (final): observation-driven candidates across hypotheses ────────

test("one hypothesis does not automatically produce one candidate", async () => {
  const run = analysisTwo(
    [evidence()],
    [evidence({ hypothesis_id: "h2", url: "https://example.org/wait", query: "rural clinic patient wait", evidence_summary: "Rural clinic patients wait long hours for appointments." })]
  );
  const prompts: string[] = [];
  const provider: LLMProvider = {
    name: "test",
    async generateJSON({ prompt }) {
      prompts.push(prompt);
      // Only the h1 call reports a candidate; h2's observations simply do not
      // establish one worth emitting — and nothing forces it to.
      const output = prompt.includes(plan.hypotheses[0].hypothesis) ? { problems: [candidate()] } : { problems: [] };
      return JSON.stringify(output);
    },
  };
  const result = await runProblemGenerator(plan, run, () => provider);

  assert.equal(prompts.length, 2); // both hypotheses were investigated...
  assert.equal(result.problems.length, 1); // ...but only one produced a candidate
  assert.equal(result.hypotheses[0].status, "generated");
  assert.equal(result.hypotheses[1].status, "insufficient_evidence");
  assert.equal(result.hypotheses[1].problems.length, 0);
  // Every call states the no-default rule explicitly.
  for (const prompt of prompts) assert.match(prompt, /default to ZERO/);
});

test("related observations from different hypotheses synthesize one candidate with provenance from both", async () => {
  const run = analysisTwo(
    [evidence({ url: "https://example.org/wait-a", query: "rural clinic wait times", evidence_summary: "Rural clinic patients wait long hours before a nurse sees them." })],
    [evidence({ hypothesis_id: "h2", url: "https://example.org/wait-b", query: "rural clinic appointment wait", evidence_summary: "Rural clinic patients wait long hours for appointments." })]
  );
  const synthesis = {
    problem_statement: "Rural clinic patients wait long hours for appointments before a nurse sees them.",
    affected_population: "Rural clinic patients",
    affected_activity: "Waiting to see a nurse at a clinic appointment",
    context: "Clinic appointments in rural areas",
    mechanism: "Patients wait long hours for appointments before a nurse sees them",
    observed_impact: "Patients wait long hours before a nurse sees them",
    evidence_indices: [1, 2],
    observations: [
      { claim: "Rural clinic patients wait long hours before a nurse sees them", evidence_indices: [1] },
      { claim: "Rural clinic patients wait long hours for appointments", evidence_indices: [2] },
    ],
  };
  const unsupportedCausal = {
    ...synthesis,
    problem_statement: "Rural clinic patients miss appointments because nurses are unavailable.",
    evidence_indices: [2],
    observations: [{ claim: "Rural clinic patients wait long hours for appointments", evidence_indices: [2] }],
  };
  const prompts: string[] = [];
  const provider: LLMProvider = {
    name: "test",
    async generateJSON({ prompt }) {
      prompts.push(prompt);
      // The host call gets its own candidate plus one unsupported one (which
      // must still be rejected); the other hypothesis found nothing new.
      const output = prompt.includes(plan.hypotheses[0].hypothesis) ? { problems: [synthesis, unsupportedCausal] } : { problems: [] };
      return JSON.stringify(output);
    },
  };
  const result = await runProblemGenerator(plan, run, () => provider);

  // The host call is offered the related observation from the other hypothesis.
  const hostPrompt = prompts.find((prompt) => prompt.includes(plan.hypotheses[0].hypothesis))!;
  assert.match(hostPrompt, /Related validated observations from OTHER hypotheses/);
  assert.ok(hostPrompt.includes("Rural clinic patients wait long hours for appointments."));

  // One synthesized candidate whose provenance spans BOTH hypotheses...
  assert.equal(result.problems.length, 1);
  const problem = result.problems[0];
  assert.equal(problem.hypothesis_id, "h1");
  assert.equal(problem.evidence_refs.length, 2);
  assert.deepEqual(problem.evidence_refs.map((ref) => ref.evidence_id).sort(), ["h1:e1", "h2:e1"]);
  assert.deepEqual(problem.evidence_refs.map((ref) => ref.hypothesis_id).sort(), ["h1", "h2"]);
  // ...while the unsupported causal claim in the same call was still rejected.
  assert.ok(!problem.problem_statement.includes("because"));
});

test("the same situation found under two hypotheses consolidates into one candidate", async () => {
  const run = analysisTwo(
    [evidence({ url: "https://example.org/wait-a", query: "rural clinic wait times", evidence_summary: "Rural clinic patients wait long hours for appointments." })],
    [evidence({ hypothesis_id: "h2", url: "https://example.org/wait-b", query: "rural clinic appointment wait", evidence_summary: "Patients at rural clinics wait long hours for appointments." })]
  );
  const underH1 = {
    problem_statement: "Rural clinic patients wait long hours for appointments.",
    affected_population: "Rural clinic patients",
    affected_activity: "Waiting for clinic appointments",
    context: "Clinic appointments in rural areas",
    mechanism: "Patients wait long hours for appointments",
    observed_impact: "Patients wait long hours before appointments",
    evidence_indices: [1],
    observations: [{ claim: "Rural clinic patients wait long hours for appointments", evidence_indices: [1] }],
  };
  const underH2 = {
    problem_statement: "Rural clinic patients wait long hours before their appointments.",
    affected_population: "Rural clinic patients",
    affected_activity: "Waiting for clinic appointments",
    context: "Clinic appointments in rural areas",
    mechanism: "Patients wait long hours for appointments",
    observed_impact: "Patients wait long hours before appointments",
    evidence_indices: [1],
    observations: [{ claim: "Patients at rural clinics wait long hours for appointments", evidence_indices: [1] }],
  };
  const provider: LLMProvider = {
    name: "test",
    async generateJSON({ prompt }) {
      return JSON.stringify({ problems: [prompt.includes(plan.hypotheses[0].hypothesis) ? underH1 : underH2] });
    },
  };
  const result = await runProblemGenerator(plan, run, () => provider);

  // Not one candidate per hypothesis: both hypotheses produced a near-identical
  // candidate for the same situation, and deduplication consolidates them.
  assert.equal(result.summary.candidate_problem_count_before_deduplication, 2);
  assert.equal(result.problems.length, 1);
  // The kept candidate carries provenance from both hypotheses...
  const kept = result.problems[0];
  assert.equal(kept.hypothesis_id, "h1");
  assert.deepEqual(kept.evidence_refs.map((ref) => ref.evidence_id).sort(), ["h1:e1", "h2:e1"]);
  // ...and the per-hypothesis lists stay exactly the union of the consolidated set.
  assert.equal(result.hypotheses.reduce((total, item) => total + item.problems.length, 0), result.problems.length);
  assert.equal(result.hypotheses[0].status, "generated");
  assert.equal(result.hypotheses[1].status, "generated"); // it did generate — before_dedup records that
  assert.equal(result.hypotheses[1].problems.length, 0); // its candidate was consolidated under h1
});

test("unrelated observations from another hypothesis are not offered for combination", async () => {
  const run = analysisTwo(
    [evidence({ url: "https://example.org/travel" })],
    [evidence({ hypothesis_id: "h2", url: "https://example.org/farm-loans", query: "farm equipment loans", evidence_summary: "Farm equipment loan defaults rise when drought years reduce crop yields." })]
  );
  const mashup = {
    ...candidate([1, 2]),
    observations: [{ claim: "Rural clinic patients travel long distances while farm equipment loans default", evidence_indices: [1, 2] }],
  };
  const prompts: string[] = [];
  const provider: LLMProvider = {
    name: "test",
    async generateJSON({ prompt }) {
      prompts.push(prompt);
      if (prompt.includes(plan.hypotheses[0].hypothesis)) return JSON.stringify({ problems: [mashup] });
      return JSON.stringify({ problems: [] });
    },
  };
  const result = await runProblemGenerator(plan, run, () => provider);

  const hostPrompt = prompts.find((prompt) => prompt.includes(plan.hypotheses[0].hypothesis))!;
  // The unrelated foreign observation is never even offered to the host call...
  assert.ok(!hostPrompt.includes("Farm equipment loan defaults"));
  // ...while the host's own validated observation is.
  assert.ok(hostPrompt.includes("Rural clinic patients travel long distances"));
  // And an attempt to cite it anyway is rejected: this prompt's citation space
  // only contains the host's own citable group 1 — index 2 does not exist.
  assert.equal(result.problems.length, 0);
  assert.equal(result.hypotheses[0].status, "insufficient_evidence");
});
