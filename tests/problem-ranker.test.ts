import assert from "node:assert/strict";
import test from "node:test";

import type { CandidateGapAnalysis, CandidateProblem, GapAnalysisResult } from "@/types";
import { runProblemRanking } from "../lib/ranking/problem-ranker";

function candidateProblem(overrides: Partial<CandidateProblem> = {}): CandidateProblem {
  return {
    id: "h1-p1",
    hypothesis_id: "h1",
    problem_statement: "Rural residents face limited access to reliable broadband internet connectivity.",
    affected_population: "Americans in rural areas",
    affected_activity: "Accessing reliable internet connectivity",
    context: "Broadband coverage gaps",
    mechanism: "Limited broadband prevents telehealth use",
    observed_impact: "Residents cannot use telehealth services",
    observations: [{ claim: "Rural residents lack coverage from fixed terrestrial broadband", evidence_indices: [1] }],
    evidence_refs: [
      { evidence_id: "h1:e1", hypothesis_id: "h1", url: "https://example.org/one", query: "q", title: "T", source: "S", evidence_summary: "summary one" },
    ],
    evidence_strength: "strong",
    ...overrides,
  };
}

function solutionRefs(candidateId: string): CandidateGapAnalysis["existing_solutions"][number]["evidence_refs"] {
  return [
    { solution_evidence_id: `${candidateId}:s1`, candidate_problem_id: candidateId, url: "https://example.org/solution", query: "q", title: "T", source: "S", evidence_summary: "solution summary" },
  ];
}

function gapAnalysis(problem: CandidateProblem, overrides: Partial<CandidateGapAnalysis> = {}): CandidateGapAnalysis {
  return {
    id: `${problem.id}-g1`,
    candidate_problem_id: problem.id,
    problem_statement: problem.problem_statement,
    status: "analyzed",
    duration_ms: 100,
    queries_executed: ["query one"],
    existing_solutions: [
      { name: "Example program", type: "Program", description: "An example program.", target_population: "Rural residents", evidence_refs: solutionRefs(problem.id) },
    ],
    addressed_aspects: ["access"],
    unresolved_gaps: [
      { gap: "Example unresolved gap", explanation: "The example gap remains.", evidence_refs: solutionRefs(problem.id) },
    ],
    solution_coverage: "partial",
    gap_confidence: "high",
    evidence_refs: solutionRefs(problem.id),
    ...overrides,
  };
}

function gapAnalysisResult(analyses: CandidateGapAnalysis[]): GapAnalysisResult {
  return {
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 1000,
    analyses,
    summary: {
      candidate_count: analyses.length,
      analyzed_count: analyses.filter((a) => a.status === "analyzed").length,
      insufficient_evidence_count: analyses.filter((a) => a.status === "insufficient_evidence").length,
      failed_count: analyses.filter((a) => a.status === "failed").length,
      solution_count: analyses.reduce((sum, a) => sum + a.existing_solutions.length, 0),
      gap_count: analyses.reduce((sum, a) => sum + a.unresolved_gaps.length, 0),
      queries_executed_count: analyses.reduce((sum, a) => sum + a.queries_executed.length, 0),
    },
  };
}

/** Timing fields vary between runs; everything else must be identical. */
function comparable(result: unknown): string {
  return JSON.stringify(result);
}

test("ranking is deterministic across runs", () => {
  const problem = candidateProblem();
  const analysis = gapAnalysis(problem);
  const input = { problems: [problem], gapAnalysis: gapAnalysisResult([analysis]) };
  const first = runProblemRanking(input.problems, input.gapAnalysis);
  const second = runProblemRanking(input.problems, input.gapAnalysis);
  assert.equal(first.status, second.status);
  assert.deepEqual(
    comparable({ ranked_problems: first.ranked_problems, summary: first.summary, insufficient_ranking: first.insufficient_ranking }),
    comparable({ ranked_problems: second.ranked_problems, summary: second.summary, insufficient_ranking: second.insufficient_ranking })
  );
});

test("component scores and reasons are calculated from validated signals", () => {
  const problem = candidateProblem();
  const analysis = gapAnalysis(problem);
  const result = runProblemRanking([problem], gapAnalysisResult([analysis]));
  const entry = result.ranked_problems[0];

  // 1. problem evidence: strong (10) + 1 supporting source (2) = 12/20
  assert.deepEqual(
    entry.components.map((component) => [component.name, component.score, component.max_score]),
    [
      ["problem_evidence_strength", 12, 20],
      ["validated_observation_coverage", 5, 15],
      ["affected_activity_specificity", 7, 10],
      ["existing_solution_evidence", 12, 20],
      ["unresolved_gap_strength", 19, 35],
    ]
  );
  // Every component explains itself with at least one concrete reason.
  for (const component of entry.components) {
    assert.ok(component.reasons.length >= 1, `${component.name} has no reasons`);
    for (const reason of component.reasons) {
      assert.ok(reason.length > 0, `${component.name} has an empty reason`);
    }
  }
  // Final opportunity score is the sum of the components.
  assert.equal(entry.opportunity_score, 12 + 5 + 7 + 12 + 19);
  assert.equal(result.status, "ranked");
  assert.equal(result.insufficient_ranking, false);
  assert.equal(entry.rank, 1);
  assert.equal(entry.rankable, true);
  assert.match(entry.rankability_reason, /rankable: gap analysis established 1 evidence-backed unresolved gap\(s\) with high confidence/);
});

test("stronger evidence and gap confidence improve rank", () => {
  const refs = (n: number, id: string) =>
    Array.from({ length: n }, (_, i) => ({
      evidence_id: `${id}:e${i + 1}`,
      hypothesis_id: "h1",
      url: `https://example.org/${id}-${i + 1}`,
      query: "q",
      title: "T",
      source: "S",
      evidence_summary: "summary",
    }));
  const observations = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ claim: `Validated observation ${i + 1} about the friction`, evidence_indices: [i + 1] }));
  const solutions = (n: number, id: string) =>
    Array.from({ length: n }, (_, i) => ({
      name: `Example program ${i + 1}`,
      type: "Program",
      description: "An example program.",
      target_population: "Rural residents",
      evidence_refs: solutionRefs(id),
    }));
  const gaps = (n: number, id: string) =>
    Array.from({ length: n }, (_, i) => ({
      gap: `Example unresolved gap ${i + 1}`,
      explanation: "The example gap remains.",
      evidence_refs: solutionRefs(id),
    }));

  const strong = candidateProblem({
    id: "h1-p1",
    evidence_strength: "strong",
    evidence_refs: refs(3, "h1"),
    observations: observations(3),
  });
  const weak = candidateProblem({
    id: "h2-p1",
    evidence_strength: "moderate",
    observations: observations(1),
  });
  const analyses = gapAnalysisResult([
    gapAnalysis(strong, { existing_solutions: solutions(3, "h1-p1"), unresolved_gaps: gaps(3, "h1-p1"), gap_confidence: "high" }),
    gapAnalysis(weak, { gap_confidence: "moderate" }),
  ]);

  const result = runProblemRanking([strong, weak], analyses);
  assert.equal(result.ranked_problems[0].candidate_problem_id, "h1-p1");
  assert.equal(result.ranked_problems[0].rank, 1);
  assert.equal(result.ranked_problems[1].candidate_problem_id, "h2-p1");
  assert.equal(result.ranked_problems[1].rank, 2);
  assert.ok(result.ranked_problems[0].opportunity_score > result.ranked_problems[1].opportunity_score);
});

test("candidates with insufficient gap evidence are not promoted above rankable candidates", () => {
  // Strong problem evidence, but the gap analysis produced nothing usable.
  const strongProblemWeakGap = candidateProblem({
    id: "h1-p1",
    evidence_strength: "strong",
    evidence_refs: [
      { evidence_id: "h1:e1", hypothesis_id: "h1", url: "https://example.org/one", query: "q", title: "T", source: "S", evidence_summary: "one" },
      { evidence_id: "h1:e2", hypothesis_id: "h1", url: "https://example.org/two", query: "q", title: "T", source: "S", evidence_summary: "two" },
      { evidence_id: "h1:e3", hypothesis_id: "h1", url: "https://example.org/three", query: "q", title: "T", source: "S", evidence_summary: "three" },
      { evidence_id: "h1:e4", hypothesis_id: "h1", url: "https://example.org/four", query: "q", title: "T", source: "S", evidence_summary: "four" },
      { evidence_id: "h1:e5", hypothesis_id: "h1", url: "https://example.org/five", query: "q", title: "T", source: "S", evidence_summary: "five" },
    ],
    observations: [
      { claim: "Validated observation one about the friction", evidence_indices: [1] },
      { claim: "Validated observation two about the friction", evidence_indices: [2] },
      { claim: "Validated observation three about the friction", evidence_indices: [3] },
    ],
  });
  // Moderate problem evidence, but a genuine evidence-backed unresolved gap.
  const moderateProblemRealGap = candidateProblem({ id: "h2-p1", evidence_strength: "moderate" });
  // Analyzed, with gaps, but only low gap confidence — weak gap evidence.
  const lowConfidence = candidateProblem({ id: "h3-p1", evidence_strength: "moderate" });
  // No gap analysis was produced at all for this candidate.
  const noAnalysis = candidateProblem({ id: "h4-p1", evidence_strength: "moderate" });

  const analyses = gapAnalysisResult([
    gapAnalysis(strongProblemWeakGap, {
      status: "insufficient_evidence",
      existing_solutions: [],
      unresolved_gaps: [],
      addressed_aspects: [],
      solution_coverage: "insufficient_solution_evidence",
      gap_confidence: "low",
      evidence_refs: [],
      error: "No usable solution evidence found.",
    }),
    gapAnalysis(moderateProblemRealGap, { gap_confidence: "moderate" }),
    gapAnalysis(lowConfidence, { gap_confidence: "low" }),
  ]);

  const result = runProblemRanking([strongProblemWeakGap, moderateProblemRealGap, lowConfidence, noAnalysis], analyses);
  const byId = new Map(result.ranked_problems.map((entry) => [entry.candidate_problem_id, entry]));

  // The candidate with real gap evidence ranks first despite weaker problem evidence.
  assert.equal(byId.get("h2-p1")?.rank, 1);
  assert.equal(byId.get("h2-p1")?.rankable, true);
  // Strong problem evidence cannot promote a candidate whose gap evidence is insufficient.
  assert.equal(byId.get("h1-p1")?.rankable, false);
  assert.equal(byId.get("h1-p1")?.rank, null);
  assert.match(byId.get("h1-p1")?.rankability_reason ?? "", /gap analysis ended "insufficient_evidence"/);
  // Low gap confidence is weak gap evidence — also not rankable.
  assert.equal(byId.get("h3-p1")?.rankable, false);
  assert.equal(byId.get("h3-p1")?.rank, null);
  assert.match(byId.get("h3-p1")?.rankability_reason ?? "", /gap confidence is low/);
  // A candidate with no gap analysis at all is not rankable.
  assert.equal(byId.get("h4-p1")?.rankable, false);
  assert.equal(byId.get("h4-p1")?.rank, null);
  assert.match(byId.get("h4-p1")?.rankability_reason ?? "", /no gap analysis was produced/);
  // Every rankable candidate precedes every non-rankable one.
  const order = result.ranked_problems.map((entry) => entry.candidate_problem_id);
  assert.ok(order.indexOf("h2-p1") < order.indexOf("h1-p1"));
  assert.ok(order.indexOf("h2-p1") < order.indexOf("h3-p1"));
  assert.ok(order.indexOf("h2-p1") < order.indexOf("h4-p1"));
});

test("ties are broken deterministically by candidate id", () => {
  const first = candidateProblem({ id: "h1-p1" });
  const second = candidateProblem({ id: "h2-p1" });
  const analyses = gapAnalysisResult([gapAnalysis(first), gapAnalysis(second)]);
  const result = runProblemRanking([second, first], analyses);
  assert.equal(result.ranked_problems[0].candidate_problem_id, "h1-p1");
  assert.equal(result.ranked_problems[0].rank, 1);
  assert.equal(result.ranked_problems[1].candidate_problem_id, "h2-p1");
  assert.equal(result.ranked_problems[1].rank, 2);
  // Identical signals produce identical scores — the tie is real, the order is not accidental.
  assert.equal(result.ranked_problems[0].opportunity_score, result.ranked_problems[1].opportunity_score);
});

test("a candidate with no unresolved gap is not rankable", () => {
  const problem = candidateProblem();
  const analysis = gapAnalysis(problem, {
    existing_solutions: [
      { name: "Complete program", type: "Program", description: "A program that covers the problem.", target_population: "Rural residents", evidence_refs: solutionRefs(problem.id) },
    ],
    unresolved_gaps: [],
    solution_coverage: "clear",
  });
  const result = runProblemRanking([problem], gapAnalysisResult([analysis]));
  const entry = result.ranked_problems[0];
  assert.equal(entry.rankable, false);
  assert.equal(entry.rank, null);
  assert.match(entry.rankability_reason, /no evidence-backed unresolved gap/);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.insufficient_ranking, true);
});

test("empty candidate list returns an explicit insufficient-ranking result", () => {
  const result = runProblemRanking([], gapAnalysisResult([]));
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.insufficient_ranking, true);
  assert.deepEqual(result.ranked_problems, []);
  assert.deepEqual(result.summary, { candidate_count: 0, rankable_count: 0, not_rankable_count: 0 });
});

test("when no candidate has sufficient gap evidence no winner is manufactured", () => {
  const first = candidateProblem({ id: "h1-p1" });
  const second = candidateProblem({ id: "h2-p1" });
  const failed = { status: "failed" as const, error: "Gap validation failed." };
  const analyses = gapAnalysisResult([
    gapAnalysis(first, { ...failed, existing_solutions: [], unresolved_gaps: [], solution_coverage: "insufficient_solution_evidence", gap_confidence: "low" }),
    gapAnalysis(second, { ...failed, existing_solutions: [], unresolved_gaps: [], solution_coverage: "insufficient_solution_evidence", gap_confidence: "low" }),
  ]);
  const result = runProblemRanking([first, second], analyses);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.insufficient_ranking, true);
  assert.equal(result.summary.rankable_count, 0);
  for (const entry of result.ranked_problems) {
    assert.equal(entry.rankable, false);
    assert.equal(entry.rank, null);
  }
});

test("complete provenance is preserved and no underlying claim is altered", () => {
  const problem = candidateProblem({
    observations: [
      { claim: "First validated observation about the friction", evidence_indices: [1] },
      { claim: "Second validated observation about the friction", evidence_indices: [2] },
    ],
  });
  const analysis = gapAnalysis(problem);
  // Deep snapshots taken before ranking — the ranker must never mutate its inputs.
  const problemBefore = JSON.parse(JSON.stringify(problem));
  const analysisBefore = JSON.parse(JSON.stringify(analysis));

  const result = runProblemRanking([problem], gapAnalysisResult([analysis]));
  const entry = result.ranked_problems[0];

  // The ranked entry carries the original objects, unaltered.
  assert.deepEqual(entry.candidate_problem, problemBefore);
  assert.deepEqual(entry.gap_analysis, analysisBefore);
  // And the inputs themselves were not mutated by ranking.
  assert.deepEqual(problem, problemBefore);
  assert.deepEqual(analysis, analysisBefore);
  // The problem statement is verbatim, never rewritten or strengthened.
  assert.equal(entry.problem_statement, problem.problem_statement);
  assert.equal(entry.candidate_problem.problem_statement, problem.problem_statement);
  assert.equal(entry.gap_analysis?.problem_statement, problem.problem_statement);
  // Every provenance reference survives.
  assert.equal(entry.candidate_problem.evidence_refs.length, problem.evidence_refs.length);
  assert.equal(entry.candidate_problem.evidence_refs[0].evidence_id, "h1:e1");
  assert.equal(entry.gap_analysis?.evidence_refs[0].solution_evidence_id, "h1-p1:s1");
  assert.equal(entry.gap_analysis?.unresolved_gaps[0].evidence_refs[0].solution_evidence_id, "h1-p1:s1");
});
