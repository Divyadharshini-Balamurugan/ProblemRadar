/**
 * Types describing how a user starts an exploration on the ProblemRadar
 * workspace: the free-text query plus the optional "Quick Start" guidance
 * that shapes (but never restricts) what they can type.
 */

/** The three top-level ways a user can kick off a ProblemRadar search. */
export type QuickStartOptionId = "discover" | "explore" | "investigate";

export interface QuickStartOption {
  id: QuickStartOptionId;
  title: string;
  description: string;
  /** Short text used to prefill / guide the exploration input when selected. */
  promptHint: string;
}

/** Category for the smaller, secondary "quick exploration" chips. */
export type ExplorationChipCategory = "people" | "industry" | "location";

export interface ExplorationChip {
  id: string;
  label: string;
  category: ExplorationChipCategory;
  /** Text inserted into / prefixed onto the exploration input when clicked. */
  promptPrefix: string;
}

/** The current guidance mode applied to the exploration input, if any. */
export interface ExplorationContext {
  optionId: QuickStartOptionId | null;
  chipId: string | null;
}
