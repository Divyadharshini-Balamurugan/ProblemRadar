/**
 * Output shape of the Intent/Scope Agent (ProblemRadar research pipeline,
 * stage 1). A local LLM (see `lib/llm/`) reads the user's free-text
 * research question and extracts this structure — nothing else in the
 * app infers or modifies it.
 */
export interface IntentScope {
  /** One of "discover" | "explore" | "investigate" | "other" (model's best guess). */
  intent: string;
  /** Industry / subject area implied by the question, or "unspecified". */
  domain: string;
  /** The specific group of people affected, or "unspecified". */
  audience: string;
  /** A specific place/region/country if mentioned, otherwise null. */
  location: string | null;
  /** The specific problem the user already has in mind, otherwise null. */
  specific_problem: string | null;
  /** How broad the request is: "narrow" | "broad" | "exploratory" (model's own wording). */
  breadth: string;
  /** Any timeframe implied by the question, e.g. "current", "last 2 years". */
  time_scope: string;
  /** 2-5 concrete things worth researching next. */
  research_targets: string[];
}
