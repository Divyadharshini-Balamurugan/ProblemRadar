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

export interface ResearchHypothesis {
  /** Short, unique identifier within the plan (e.g. "h1"). */
  id: string;
  lens: ResearchLens;
  /** A single, concrete, falsifiable statement of the suspected problem. */
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
