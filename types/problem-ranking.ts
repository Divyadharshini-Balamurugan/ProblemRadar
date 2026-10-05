/**
 * Types for the Problem Ranking stage (ProblemRadar research
 * pipeline, the stage after Gap Analysis). It answers:
 * "Given evidence-grounded candidate problems and their gap
 * analyses, which unresolved problems are the strongest
 * opportunities?"
 *
 * Ranking is deterministic and evidence-based — no LLM is
 * involved. Every score is computed only from signals that
 * already exist in the pipeline (the candidate's evidence
 * strength, supporting-source count, validated observations,
 * affected-activity/problem specificity, and the gap
 * analysis's own solution evidence, unresolved-gap evidence,
 * and gap confidence). No severity, frequency, market size,
 * demand, financial value, or impact is ever invented.
 *
 * The ranking never alters, rewrites, or strengthens the
 * underlying claims: each ranked entry carries the original
 * CandidateProblem and CandidateGapAnalysis by reference.
 */

import type { CandidateGapAnalysis } from "./gap-analysis";
import type { CandidateProblem } from "./problem-generation";

/** One transparent, explainable scoring component. */
export interface ScoreComponent {
  /** Machine-readable component name (e.g. "unresolved_gap_strength"). */
  name: string;
  /** Component score achieved (0..max_score). */
  score: number;
  /** Maximum possible component score. */
  max_score: number;
  /** Human-readable reasons — exactly which validated signals produced the score. */
  reasons: string[];
}

/** One candidate problem with its deterministic ranking outcome. */
export interface RankedCandidateProblem {
  candidate_problem_id: string;
  hypothesis_id: string;
  /** Copied verbatim from the candidate — never rewritten. */
  problem_statement: string;
  /** 1-based rank among rankable candidates, or null when the candidate is not rankable. */
  rank: number | null;
  /** True only when the candidate has sufficient gap evidence to be prioritized. */
  rankable: boolean;
  /** Why the candidate is (or is not) rankable. */
  rankability_reason: string;
  /** Final opportunity score (0..100) — the sum of the component scores. */
  opportunity_score: number;
  /** Transparent component scores with reasons, so the UI can explain why one problem ranks above another. */
  components: ScoreComponent[];
  /** The original candidate problem, preserved unaltered with all of its evidence provenance. */
  candidate_problem: CandidateProblem;
  /** The original gap analysis for this candidate, preserved unaltered (null when none was produced). */
  gap_analysis: CandidateGapAnalysis | null;
}

export interface ProblemRankingResult {
  started_at: string;
  completed_at: string;
  duration_ms: number;
  /** "ranked" when at least one candidate has sufficient gap evidence; "insufficient_evidence" when none does. */
  status: "ranked" | "insufficient_evidence";
  /** Explicit insufficient-ranking flag: true when no candidate could be meaningfully ranked — no winner is manufactured. */
  insufficient_ranking: boolean;
  /** All candidates in deterministic order: rankable candidates first (by score, then id), then the rest. */
  ranked_problems: RankedCandidateProblem[];
  summary: {
    candidate_count: number;
    rankable_count: number;
    not_rankable_count: number;
  };
}
