/**
 * Types for the Gap Analysis stage (ProblemRadar research pipeline, the
 * stage after Problem Generator). It answers: "Given this
 * evidence-grounded candidate problem, what existing solutions already
 * address it, and what evidence-supported gap remains?"
 *
 * Everything in this shape is either traceable back to a real SearchResult
 * from the stage's own focused SerpApi searches, or derived from the final
 * deduplicated Candidate Problem it started from — the LLM only
 * synthesizes; code resolves references, validates grounding, dedupes, and
 * isolates failures.
 */

/** One reference to a real SearchResult collected during gap analysis — the gap-stage equivalent of `ProblemEvidenceReference`. */
export interface GapEvidenceReference {
  /** Stable id of this reference's source within the candidate's own evidence list (`<candidate_id>:s<n>`). */
  solution_evidence_id: string;
  candidate_problem_id: string;
  url: string;
  query: string;
  title: string;
  source: string;
  /** The source snippet this reference stands for. */
  evidence_summary: string;
}

/** One existing solution found in the search evidence — never invented. */
export interface ExistingSolution {
  name: string;
  /** product | service | platform | program | policy | organization | workflow | technology (free-form but concrete). */
  type: string;
  description: string;
  target_population: string;
  evidence_refs: GapEvidenceReference[];
}

/** One evidence-supported unresolved gap. */
export interface UnresolvedGap {
  gap: string;
  explanation: string;
  evidence_refs: GapEvidenceReference[];
}

export type SolutionCoverage = "clear" | "partial" | "insufficient_solution_evidence";
export type GapConfidence = "high" | "moderate" | "low";
export type GapAnalysisStatus = "analyzed" | "insufficient_evidence" | "failed";

/** The gap-analysis outcome for one candidate problem. */
export interface CandidateGapAnalysis {
  id: string;
  candidate_problem_id: string;
  /** Copied verbatim from the candidate problem — never rewritten by this stage. */
  problem_statement: string;
  status: GapAnalysisStatus;
  duration_ms: number;
  queries_executed: string[];
  existing_solutions: ExistingSolution[];
  addressed_aspects: string[];
  unresolved_gaps: UnresolvedGap[];
  solution_coverage: SolutionCoverage;
  gap_confidence: GapConfidence;
  evidence_refs: GapEvidenceReference[];
  error?: string;
}

export interface GapAnalysisResult {
  started_at: string;
  completed_at: string;
  duration_ms: number;
  analyses: CandidateGapAnalysis[];
  summary: {
    candidate_count: number;
    analyzed_count: number;
    insufficient_evidence_count: number;
    failed_count: number;
    solution_count: number;
    gap_count: number;
    queries_executed_count: number;
  };
}
