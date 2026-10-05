/**
 * Output shape of the Research Planner (ProblemRadar research pipeline,
 * stage 2). Takes a validated `IntentScope` (stage 1's output) and turns
 * it into a small set of concrete, falsifiable research hypotheses, each
 * with candidate public search queries — still no web search is actually
 * run here, this only plans what to look for, where, and how someone
 * would search for it, ready for a future search-execution stage.
 */

/**
 * Controlled vocabulary of "lenses" a hypothesis can be framed through.
 * Kept as a fixed list (rather than free text) so hypotheses stay
 * genuinely distinct angles on the problem instead of keyword variations
 * of the same idea — the planner selects only the lenses relevant to a
 * given scope, one hypothesis per lens.
 */
export const RESEARCH_LENSES = [
  "time",
  "cost",
  "manual_work",
  "availability",
  "access",
  "coordination",
  "information",
  "reliability",
  "trust",
  "compliance",
  "workflow",
  "existing_solution_failure",
  "workaround",
] as const;

export type ResearchLens = (typeof RESEARCH_LENSES)[number];

/**
 * Canonical discovery angles (stage 2 investigation framing). The planner
 * picks the relevant subset for the given scope — it does NOT force all
 * eight on every request. `lens` describes the *problem type* (kept as-is
 * downstream); `angle` describes *how we investigate* it.
 */
export const DISCOVERY_ANGLES = [
  "friction",
  "workflow",
  "workaround",
  "complaints",
  "research",
  "institutional_evidence",
  "existing_solution_failure",
  "contradiction",
] as const;

export type DiscoveryAngle = (typeof DISCOVERY_ANGLES)[number];

export interface ResearchHypothesis {
  /** Short, unique identifier within the plan (e.g. "h1"). */
  id: string;
  lens: ResearchLens;
  /** Which discovery angle this investigation explores. */
  angle: DiscoveryAngle;
  /**
   * An investigation QUESTION about what is happening in the domain — not
   * a statement that the problem is real. E.g. "What barriers affect rural
   * residents while accessing healthcare services?"
   */
  hypothesis: string;
  /**
   * What evidence, if found, would confirm or refute this hypothesis —
   * must name publicly discoverable evidence (recent news, government/
   * municipal reports, official announcements, public tenders, RTI
   * disclosures, citizen complaint/grievance data, open datasets, surveys,
   * reviews), not internal records nobody outside the org could reach.
   */
  evidence_targets: string[];
  /** Realistic public source *types* a search could target for that evidence. */
  source_strategies: string[];
  /**
   * Diverse, realistic search-engine query strings a person could type to
   * find public evidence for this hypothesis (location/domain-specific
   * where relevant). Candidates for a future search-execution stage —
   * still not run here.
   */
  search_queries: string[];
}

export interface SearchBudget {
  /** Max search queries to spend investigating each hypothesis. */
  max_queries_per_hypothesis: number;
  /** Max distinct sources to pull evidence from per hypothesis. */
  max_sources_per_hypothesis: number;
  /** Total query budget across the whole plan (all hypotheses combined). */
  total_query_budget: number;
}

export interface ResearchPlan {
  hypotheses: ResearchHypothesis[];
  search_budget: SearchBudget;
}
