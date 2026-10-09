import assert from "node:assert/strict";
import test from "node:test";

import type {
  CandidateProblem,
  ProblemRankingResult,
  RankedCandidateProblem,
} from "@/types";
import {
  coverageLabel,
  formatOpportunityScore,
  gapConfidenceLabel,
  rankedOpportunities,
  scoreBarWidth,
  sortedComponents,
  summarizeRanking,
  topOpportunity,
} from "../lib/final-result";

function candidateProblem(
  overrides: Partial<CandidateProblem> = {}
): CandidateProblem {
  return {
    id: "h1-p1",
    hypothesis_id: "h1",
    problem_statement:
      "Rural residents face limited access to reliable broadband internet connectivity.",
    affected_population: "Americans in rural areas",
    affected_activity: "Accessing reliable internet connectivity",
    context: "Broadband coverage gaps",
    mechanism: "Limited broadband prevents telehealth use",
    observed_impact: "Residents cannot use telehealth services",
    observations: [
      { claim: "Rural residents lack fixed terrestrial broadband coverage", evidence_indices: [1] },
    ],
    evidence_refs: [
      {
        evidence_id: "h1:e1",
        hypothesis_id: "h1",
        url: "https://example.org/one",
        query: "rural broadband access",
        title: "Rural broadband report",
        source: "example.org",
        evidence_summary: "summary one",
      },
    ],
    evidence_strength: "strong",
    ...overrides,
  };
}

function rankedProblem(
  overrides: Partial<RankedCandidateProblem> = {}
): RankedCandidateProblem {
  return {
    candidate_problem_id: "h1-p1",
    hypothesis_id: "h1",
    problem_statement:
      "Rural residents face limited access to reliable broadband internet connectivity.",
    rank: 1,
    rankable: true,
    rankability_reason: "Sufficient gap evidence with high confidence.",
    opportunity_score: 91,
    components: [
      {
        name: "unresolved_gap_strength",
        score: 40,
        max_score: 40,
        reasons: ["High-confidence unresolved gap with direct evidence."],
      },
      {
        name: "evidence_strength",
        score: 20,
        max_score: 25,
        reasons: ["Strong evidence strength."],
      },
    ],
    candidate_problem: candidateProblem(),
    gap_analysis: null,
    ...overrides,
  };
}

function rankingResult(
  problems: RankedCandidateProblem[],
  overrides: Partial<ProblemRankingResult> = {}
): ProblemRankingResult {
  return {
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 10,
    status: "ranked",
    insufficient_ranking: false,
    ranked_problems: problems,
    summary: {
      candidate_count: problems.length,
      rankable_count: problems.filter((problem) => problem.rankable).length,
      not_rankable_count: problems.filter((problem) => !problem.rankable).length,
    },
    ...overrides,
  };
}

test("rankedOpportunities returns only rankable problems in rank order", () => {
  const second = rankedProblem({ rank: 2, opportunity_score: 77 });
  const first = rankedProblem({ rank: 1, opportunity_score: 91 });
  const notRankable = rankedProblem({
    rank: null,
    rankable: false,
    rankability_reason: "No unresolved gap evidence.",
  });
  const result = rankingResult([second, notRankable, first]);

  const ranked = rankedOpportunities(result);

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].opportunity_score, 91);
  assert.equal(ranked[1].rank, 2);
  assert.equal(ranked[1].opportunity_score, 77);
});

test("rankedOpportunities returns an empty list when nothing is rankable", () => {
  const result = rankingResult(
    [
      rankedProblem({
        rank: null,
        rankable: false,
        rankability_reason: "No unresolved gap evidence.",
      }),
    ],
    {
      status: "insufficient_evidence",
      insufficient_ranking: true,
      summary: { candidate_count: 1, rankable_count: 0, not_rankable_count: 1 },
    }
  );

  assert.deepEqual(rankedOpportunities(result), []);
});

test("topOpportunity returns the highest-ranked problem", () => {
  const result = rankingResult([
    rankedProblem({ rank: 2, opportunity_score: 77 }),
    rankedProblem({ rank: 1, opportunity_score: 91 }),
  ]);

  const top = topOpportunity(result);

  assert.equal(top?.rank, 1);
  assert.equal(top?.opportunity_score, 91);
});

test("topOpportunity returns null when nothing is rankable", () => {
  const result = rankingResult(
    [],
    { status: "insufficient_evidence", insufficient_ranking: true }
  );

  assert.equal(topOpportunity(result), null);
});

test("formatOpportunityScore rounds to a whole-number score out of 100", () => {
  assert.equal(formatOpportunityScore(91), "91/100");
  assert.equal(formatOpportunityScore(77.4), "77/100");
});

test("scoreBarWidth clamps the percentage between 0 and 100", () => {
  assert.equal(scoreBarWidth(50, 200), 25);
  assert.equal(scoreBarWidth(150, 100), 100);
  assert.equal(scoreBarWidth(-5, 100), 0);
  assert.equal(scoreBarWidth(5, 0), 0);
});

test("coverageLabel and gapConfidenceLabel describe the real enum values", () => {
  assert.equal(coverageLabel("clear"), "clearly covered by existing solutions");
  assert.equal(
    coverageLabel("partial"),
    "partially covered by existing solutions"
  );
  assert.equal(
    coverageLabel("insufficient_solution_evidence"),
    "insufficient solution evidence"
  );
  assert.equal(gapConfidenceLabel("high"), "high gap confidence");
  assert.equal(gapConfidenceLabel("moderate"), "moderate gap confidence");
  assert.equal(gapConfidenceLabel("low"), "low gap confidence");
});

test("summarizeRanking describes ranked and insufficient runs", () => {
  const ranked = rankingResult([
    rankedProblem({ rank: 1, opportunity_score: 91 }),
    rankedProblem({ rank: 2, opportunity_score: 77 }),
    rankedProblem({
      rank: null,
      rankable: false,
      rankability_reason: "No unresolved gap evidence.",
    }),
  ]);
  assert.equal(
    summarizeRanking(ranked),
    "2 of 3 candidates rankable by opportunity."
  );

  const insufficient = rankingResult(
    [
      rankedProblem({
        rank: null,
        rankable: false,
        rankability_reason: "No unresolved gap evidence.",
      }),
    ],
    {
      status: "insufficient_evidence",
      insufficient_ranking: true,
      summary: { candidate_count: 1, rankable_count: 0, not_rankable_count: 1 },
    }
  );
  assert.equal(
    summarizeRanking(insufficient),
    "No candidate is rankable yet — 1 candidate lacked sufficient gap evidence."
  );
});

test("sortedComponents orders components by score descending", () => {
  const problem = rankedProblem({
    components: [
      { name: "a", score: 10, max_score: 20, reasons: [] },
      { name: "b", score: 30, max_score: 40, reasons: [] },
      { name: "c", score: 20, max_score: 30, reasons: [] },
    ],
  });

  const sorted = sortedComponents(problem);

  assert.deepEqual(
    sorted.map((component) => component.name),
    ["b", "c", "a"]
  );
});
