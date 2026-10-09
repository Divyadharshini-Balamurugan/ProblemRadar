/**
 * Deterministic, evidence-based ranking of validated candidate
 * problems. This is a pure function over data that already exists
 * in the pipeline — no LLM, no search, no external signal. It
 * never invents severity, frequency, market size, demand,
 * financial value, or impact: every component score is derived
 * from validated signals (candidate evidence strength and
 * supporting-source count, validated observations,
 * affected-activity/problem specificity, and the gap analysis's
 * own solution evidence, unresolved-gap evidence, and gap
 * confidence), and every component carries the reasons a UI can
 * show to explain why one problem ranks above another.
 *
 * Ranking never alters, rewrites, or strengthens the underlying
 * claims: ranked entries carry the original CandidateProblem and
 * CandidateGapAnalysis objects by reference.
 *
 * Rankability gate: a candidate is only rankable when its gap
 * analysis actually established evidence-backed unresolved gaps
 * (status "analyzed", at least one unresolved gap, gap confidence
 * high or moderate). Candidates with insufficient or weak gap
 * evidence are never promoted above rankable candidates, no matter
 * how strong their problem evidence is. When no candidate is
 * rankable, the result is an explicit insufficient-ranking result
 * rather than a manufactured winner.
 */

import type {
  CandidateGapAnalysis,
  CandidateProblem,
  GapAnalysisResult,
  ProblemRankingResult,
  RankedCandidateProblem,
  ScoreComponent,
} from "@/types";

/** Sub-word count of the problem statement and affected activity, used as the specificity signal. */
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3)
  );
}

/**
 * Whether a candidate's gap analysis provides sufficient evidence
 * to prioritize the problem: the analysis completed, established
 * at least one evidence-backed unresolved gap, and did so with
 * better than low confidence.
 */
export function hasSufficientGapEvidence(analysis: CandidateGapAnalysis | null): boolean {
  return (
    analysis !== null &&
    analysis.status === "analyzed" &&
    analysis.unresolved_gaps.length > 0 &&
    analysis.gap_confidence !== "low"
  );
}

interface CandidateScore {
  components: ScoreComponent[];
  rankable: boolean;
  rankability_reason: string;
}

function scoreCandidate(problem: CandidateProblem, analysis: CandidateGapAnalysis | null): CandidateScore {
  const components: ScoreComponent[] = [];

  // 1. Problem evidence strength (max 20): the candidate's own
  //    validated evidence — its strength grade plus the number of
  //    supporting sources in its provenance (capped at 5).
  const strengthScore = problem.evidence_strength === "strong" ? 10 : 5;
  const sourceBonus = Math.min(problem.evidence_refs.length, 5) * 2;
  components.push({
    name: "problem_evidence_strength",
    score: strengthScore + sourceBonus,
    max_score: 20,
    reasons: [
      `candidate evidence strength: ${problem.evidence_strength} (${strengthScore}/10)`,
      `${problem.evidence_refs.length} supporting evidence source(s) in the candidate's own provenance (${sourceBonus}/10, capped at 5 sources)`,
    ],
  });

  // 2. Validated observation coverage (max 15): atomic, validated
  //    claims backing the candidate (capped at 3).
  const observationCount = problem.observations?.length ?? 0;
  const observationScore = observationCount === 0 ? 0 : observationCount === 1 ? 5 : observationCount === 2 ? 10 : 15;
  components.push({
    name: "validated_observation_coverage",
    score: observationScore,
    max_score: 15,
    reasons: [
      observationCount === 0
        ? "no validated observations were supplied with this candidate (0/15)"
        : `${observationCount} validated observation(s) back this candidate (${observationScore}/15, capped at 3 observations)`,
    ],
  });

  // 3. Affected activity / problem specificity (max 10): how concretely
  //    the affected activity and problem statement are described, measured
  //    as their combined distinct content-word count.
  const specificityWords = contentWords(`${problem.affected_activity} ${problem.problem_statement}`).size;
  const specificityScore = specificityWords >= 14 ? 10 : specificityWords >= 10 ? 7 : specificityWords >= 6 ? 4 : 1;
  components.push({
    name: "affected_activity_specificity",
    score: specificityScore,
    max_score: 10,
    reasons: [
      `affected activity and problem statement name ${specificityWords} concrete detail word(s) (${specificityScore}/10)`,
    ],
  });

  // 4. Existing-solution evidence (max 20): how well the gap analysis's
  //    own retrieved evidence establishes the solution landscape — the
  //    number of concrete existing solutions (capped at 3) and the
  //    coverage those solutions achieve. Partial coverage is the
  //    actionable opportunity zone: solutions exist but do not cover
  //    the whole problem.
  const solutionCount = analysis?.existing_solutions.length ?? 0;
  const solutionScore = analysis ? Math.min(solutionCount, 3) * 4 : 0;
  const coverageScore = !analysis
    ? 0
    : analysis.solution_coverage === "partial"
      ? 8
      : analysis.solution_coverage === "clear"
        ? 4
        : 0;
  components.push({
    name: "existing_solution_evidence",
    score: solutionScore + coverageScore,
    max_score: 20,
    reasons: analysis
      ? [
          `${solutionCount} existing solution(s) established by the gap analysis's retrieved evidence (${solutionScore}/12, capped at 3 solutions)`,
          `solution coverage: ${analysis.solution_coverage} (${coverageScore}/8 — partial coverage leaves an actionable opportunity zone; clear coverage means the retrieved solutions address the problem; insufficient_solution_evidence means no relevant solution evidence was found)`,
        ]
      : ["no gap analysis was produced for this candidate — no solution evidence available (0/20)"],
  });

  // 5. Unresolved gap strength (max 35): the core opportunity signal —
  //    evidence-backed unresolved gaps (capped at 3), the provenance
  //    references backing them (capped at 4), and the gap confidence.
  const gapCount = analysis?.unresolved_gaps.length ?? 0;
  const gapScore = analysis ? Math.min(gapCount, 3) * 5 : 0;
  const gapRefCount = analysis ? analysis.unresolved_gaps.reduce((sum, gap) => sum + gap.evidence_refs.length, 0) : 0;
  const gapRefScore = analysis ? Math.min(gapRefCount, 4) * 2 : 0;
  const confidenceScore = !analysis ? 0 : analysis.gap_confidence === "high" ? 12 : analysis.gap_confidence === "moderate" ? 7 : 2;
  components.push({
    name: "unresolved_gap_strength",
    score: gapScore + gapRefScore + confidenceScore,
    max_score: 35,
    reasons: analysis
      ? [
          `${gapCount} evidence-backed unresolved gap(s) (${gapScore}/15, capped at 3 gaps)`,
          `${gapRefCount} provenance reference(s) across those gaps (${gapRefScore}/8, capped at 4 references)`,
          `gap confidence: ${analysis.gap_confidence} (${confidenceScore}/12)`,
        ]
      : ["no gap analysis was produced for this candidate — no unresolved-gap evidence available (0/35)"],
  });

  // Rankability gate: sufficient gap evidence. Candidates without it
  // are never promoted above rankable candidates, regardless of how
  // strong their problem evidence is.
  const rankable = hasSufficientGapEvidence(analysis);
  let rankability_reason: string;
  if (!analysis) {
    rankability_reason = "not rankable: no gap analysis was produced for this candidate, so there is no evidence of an unresolved gap to prioritize";
  } else if (analysis.status !== "analyzed") {
    rankability_reason = `not rankable: gap analysis ended "${analysis.status}" (${analysis.error ?? "no evidence-backed solutions or gaps were established"}), so there is no unresolved-gap evidence to prioritize`;
  } else if (analysis.unresolved_gaps.length === 0) {
    rankability_reason = "not rankable: the gap analysis established no evidence-backed unresolved gap — the retrieved evidence shows existing solutions address the candidate problem";
  } else if (analysis.gap_confidence === "low") {
    rankability_reason = "not rankable: gap confidence is low — the unresolved-gap evidence is too weak to prioritize this candidate";
  } else {
    rankability_reason = `rankable: gap analysis established ${gapCount} evidence-backed unresolved gap(s) with ${analysis.gap_confidence} confidence`;
  }

  return { components, rankable, rankability_reason };
}

/**
 * Rank validated candidate problems by opportunity, using only the
 * validated signals already present in the pipeline. Deterministic:
 * identical inputs always produce identical ordering and scores
 * (ties break by candidate_problem_id, ascending). The input
 * objects are never mutated — ranked entries reference them as-is.
 */
export function runProblemRanking(problems: CandidateProblem[], gapAnalysis: GapAnalysisResult): ProblemRankingResult {
  const started = Date.now();
  const analysesByProblem = new Map(gapAnalysis.analyses.map((analysis) => [analysis.candidate_problem_id, analysis]));

  const ranked: RankedCandidateProblem[] = problems.map((problem) => {
    const analysis = analysesByProblem.get(problem.id) ?? null;
    const { components, rankable, rankability_reason } = scoreCandidate(problem, analysis);
    return {
      candidate_problem_id: problem.id,
      hypothesis_id: problem.hypothesis_id,
      problem_statement: problem.problem_statement,
      rank: null,
      rankable,
      rankability_reason,
      opportunity_score: components.reduce((sum, component) => sum + component.score, 0),
      components,
      candidate_problem: problem,
      gap_analysis: analysis,
    };
  });

  // Deterministic order: rankable candidates first, then opportunity
  // score (descending), then candidate_problem_id (ascending) as a
  // stable tiebreak.
  ranked.sort((a, b) => {
    if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
    if (a.opportunity_score !== b.opportunity_score) return b.opportunity_score - a.opportunity_score;
    return a.candidate_problem_id.localeCompare(b.candidate_problem_id);
  });

  // Ranks are assigned only to rankable candidates. When nothing is
  // rankable, no winner is manufactured.
  const rankableCount = ranked.filter((entry) => entry.rankable).length;
  let rank = 0;
  for (const entry of ranked) {
    if (entry.rankable) {
      rank += 1;
      entry.rank = rank;
    }
  }

  return {
    started_at: new Date(started).toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    status: rankableCount > 0 ? "ranked" : "insufficient_evidence",
    insufficient_ranking: rankableCount === 0,
    ranked_problems: ranked,
    summary: {
      candidate_count: problems.length,
      rankable_count: rankableCount,
      not_rankable_count: problems.length - rankableCount,
    },
  };
}
