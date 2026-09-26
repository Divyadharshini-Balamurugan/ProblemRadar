/**
 * Output shape of the Evidence Analyzer (ProblemRadar research pipeline,
 * stage 4). Takes an already-validated `ResearchPlan` (stage 2) and its
 * matching `SearchRun` (stage 3's output) and, hypothesis by hypothesis,
 * classifies each retrieved `SearchResult` against that hypothesis using
 * only the text the SearchRun actually contains — still no scoring,
 * ranking, or problem generation here, just structured, source-traceable
 * evidence for a future stage to build on.
 */

/**
 * How one source relates to the hypothesis it was retrieved for.
 * "neutral" also covers "insufficient evidence" (a source that's related
 * but doesn't clearly support or challenge the claim, or is too thin to
 * tell) — kept as one bucket rather than two, since the distinction
 * between "not enough to judge" and "genuinely neutral" isn't something
 * the retrieved text usually settles either way.
 */
export const EVIDENCE_STANCES = ["supports", "challenges", "neutral"] as const;
export type EvidenceStance = (typeof EVIDENCE_STANCES)[number];

/** How directly a source's evidence actually bears on the hypothesis's specific claim (an LLM judgment call, not computable from metadata alone). */
export const EVIDENCE_RELEVANCE_LEVELS = ["high", "medium", "low"] as const;
export type EvidenceRelevance = (typeof EVIDENCE_RELEVANCE_LEVELS)[number];

/**
 * How recent a source is, computed deterministically in code from the
 * SearchResult's own `published_date` — never left to the model to judge,
 * since it's plain date arithmetic, not interpretation. "unknown" means
 * the SearchRun gave no usable date, not that the source is old.
 */
export const EVIDENCE_RECENCY_LEVELS = ["recent", "dated", "unknown"] as const;
export type EvidenceRecency = (typeof EVIDENCE_RECENCY_LEVELS)[number];

/**
 * One source's evidence for one hypothesis. `url` and `query` are copied
 * verbatim from the originating `SearchResult` — never re-typed or
 * paraphrased by the model — so every entry stays traceable back to the
 * exact retrieved source and the query that found it.
 */
export interface SourceEvidence {
  hypothesis_id: string;
  /** The source's original URL, exactly as it appears in the SearchRun's `results`. */
  url: string;
  /** The exact query that retrieved this source (from the same SearchResult). */
  query: string;
  title: string;
  /** Domain/source label, copied from the SearchResult. */
  source: string;
  stance: EvidenceStance;
  relevance: EvidenceRelevance;
  recency: EvidenceRecency;
  /**
   * The relevant evidence extracted from this source's own title/snippet
   * — a grounded paraphrase or quote, never a fact the source didn't
   * actually state. Checked, not just prompted for (see
   * `lib/llm/evidence-analyzer.ts`).
   */
  evidence_summary: string;
}

/** Why a hypothesis has no `SourceEvidence` entries, or why analysis wasn't attempted/completed for it. */
export type HypothesisEvidenceStatus = "analyzed" | "no_evidence" | "failed";

/**
 * One hypothesis's full evidence picture. `support_count` /
 * `challenge_count` / `neutral_count` are always computed deterministically
 * from `evidence` in code (never asked of the model), so they can never
 * drift from the entries they summarize.
 */
export interface HypothesisEvidenceAnalysis {
  hypothesis_id: string;
  lens: string;
  hypothesis: string;
  status: HypothesisEvidenceStatus;
  /** Present only when `status` is "failed" — why this hypothesis couldn't be analyzed. */
  error?: string;
  evidence: SourceEvidence[];
  support_count: number;
  challenge_count: number;
  neutral_count: number;
}

/** The full record of one Evidence Analyzer run, one entry per hypothesis in the plan, in plan order. */
export interface EvidenceAnalysisRun {
  started_at: string;
  completed_at: string;
  duration_ms: number;
  hypotheses: HypothesisEvidenceAnalysis[];
}
