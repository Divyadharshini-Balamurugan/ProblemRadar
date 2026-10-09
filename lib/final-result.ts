import type {
  GapConfidence,
  ProblemRankingResult,
  RankedCandidateProblem,
  ScoreComponent,
  SolutionCoverage,
} from "@/types";

/**
 * Pure helpers for the final results panel. They only read the real
 * `ProblemRankingResult` produced by the Problem Ranker (Stage 7) and
 * format it for display — nothing here invents, derives, or defaults
 * a value that the ranking response didn't contain.
 */

/** Rankable entries, ordered by their 1-based rank. */
export function rankedOpportunities(
  result: ProblemRankingResult
): RankedCandidateProblem[] {
  return result.ranked_problems
    .filter((problem) => problem.rankable && problem.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
}

/** The top-ranked opportunity, or null when nothing is rankable. */
export function topOpportunity(
  result: ProblemRankingResult
): RankedCandidateProblem | null {
  const ranked = rankedOpportunities(result);
  return ranked.length > 0 ? ranked[0] : null;
}

/** A whole-number opportunity score out of 100, e.g. "91/100". */
export function formatOpportunityScore(score: number): string {
  return `${Math.round(score)}/100`;
}

/** A component's score as a 0–100 bar width, clamped. */
export function scoreBarWidth(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((score / maxScore) * 100)));
}

export function coverageLabel(coverage: SolutionCoverage): string {
  switch (coverage) {
    case "clear":
      return "clearly covered by existing solutions";
    case "partial":
      return "partially covered by existing solutions";
    case "insufficient_solution_evidence":
      return "insufficient solution evidence";
  }
}

export function gapConfidenceLabel(confidence: GapConfidence): string {
  switch (confidence) {
    case "high":
      return "high gap confidence";
    case "moderate":
      return "moderate gap confidence";
    case "low":
      return "low gap confidence";
  }
}

/** One-line, real-data summary of a ranking run. */
export function summarizeRanking(result: ProblemRankingResult): string {
  const { candidate_count: candidateCount, rankable_count: rankableCount } =
    result.summary;
  if (result.insufficient_ranking) {
    return `No candidate is rankable yet — ${candidateCount} candidate${
      candidateCount === 1 ? "" : "s"
    } lacked sufficient gap evidence.`;
  }
  return `${rankableCount} of ${candidateCount} candidate${
    candidateCount === 1 ? "" : "s"
  } rankable by opportunity.`;
}

/** Score components ordered by contribution (highest first). */
export function sortedComponents(
  problem: RankedCandidateProblem
): ScoreComponent[] {
  return [...problem.components].sort((a, b) => b.score - a.score);
}
