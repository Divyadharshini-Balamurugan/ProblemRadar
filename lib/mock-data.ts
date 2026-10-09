import type { ExplorationChip, QuickStartOption } from "@/types";

/**
 * Guided-input suggestions for the home page (Quick Start options and
 * exploration chips). These are static UI affordances only — selecting
 * one prefills the exploration input, and the research itself always
 * runs the real pipeline for whatever query the user submits.
 */

export const QUICK_START_OPTIONS: QuickStartOption[] = [
  {
    id: "discover",
    title: "Discover Problems",
    description: "I don't know what to build yet",
    promptHint: "Show me real problems worth solving right now",
  },
  {
    id: "explore",
    title: "Explore an Area",
    description: "Find problems in an industry, audience, or location",
    promptHint: "Find problems in ",
  },
  {
    id: "investigate",
    title: "Investigate a Problem",
    description: "I already have a problem in mind",
    promptHint: "Validate whether this is a real, recurring problem: ",
  },
];

export const EXPLORATION_CHIPS: ExplorationChip[] = [
  {
    id: "chip-people",
    label: "People",
    category: "people",
    promptPrefix: "Find problems faced by ",
  },
  {
    id: "chip-industry",
    label: "Industry",
    category: "industry",
    promptPrefix: "Find problems in the industry: ",
  },
  {
    id: "chip-location",
    label: "Location",
    category: "location",
    promptPrefix: "Find problems specific to this location: ",
  },
];
