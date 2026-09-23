/**
 * Types for a discovered "problem" and its supporting evidence. The
 * results page renders these from mock data today; the shape is meant to
 * match what the future evidence-analysis pipeline would return.
 */

export type RecurrenceLevel = "high" | "medium" | "low";

export interface ProblemEvidenceSource {
  id: string;
  label: string;
  url?: string;
}

export interface Problem {
  id: string;
  title: string;
  description: string;
  recurrence: RecurrenceLevel;
  /** How many independent mentions/threads this recurrence is based on. */
  recurrenceCount: number;
  evidenceCount: number;
  tags: string[];
  sources: ProblemEvidenceSource[];
}
