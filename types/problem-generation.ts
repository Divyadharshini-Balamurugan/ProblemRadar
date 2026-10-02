export type ProblemEvidenceStrength = "strong" | "moderate";

export interface ProblemEvidenceReference {
  /** Stable index into the matching hypothesis's original EvidenceAnalysis evidence array. */
  evidence_id: string;
  hypothesis_id: string;
  url: string;
  query: string;
  title: string;
  source: string;
  evidence_summary: string;
}

export interface CandidateProblem {
  id: string;
  hypothesis_id: string;
  problem_statement: string;
  affected_population: string;
  /** The concrete activity/workflow made difficult — must be supported by the candidate's evidence_refs. */
  affected_activity: string;
  context: string;
  mechanism: string;
  observed_impact: string;
  /** Evidence-backed atomic claims backing the synthesized fields above. */
  observations?: Array<{ claim: string; evidence_indices: number[] }>;
  evidence_refs: ProblemEvidenceReference[];
  evidence_strength: ProblemEvidenceStrength;
}

export type ProblemGenerationHypothesisStatus = "generated" | "no_evidence" | "insufficient_evidence" | "failed";

export interface HypothesisProblemGeneration {
  hypothesis_id: string;
  status: ProblemGenerationHypothesisStatus;
  duration_ms: number;
  supporting_evidence_count: number;
  challenging_evidence_count: number;
  problems_before_deduplication_count: number;
  problems: CandidateProblem[];
  error?: string;
}

export interface ProblemGenerationResult {
  started_at: string;
  completed_at: string;
  duration_ms: number;
  hypotheses: HypothesisProblemGeneration[];
  problems: CandidateProblem[];
  summary: {
    hypothesis_count: number;
    generated_hypothesis_count: number;
    no_evidence_hypothesis_count: number;
    insufficient_evidence_hypothesis_count: number;
    failed_hypothesis_count: number;
    candidate_problem_count_before_deduplication: number;
    candidate_problem_count: number;
  };
}
