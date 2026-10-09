/**
 * The real ProblemRadar pipeline as the UI sees it: seven stages, each
 * mapped to an actual agent/API route (see lib/api-client.ts). Statuses
 * are driven by real execution only — a stage is "running" while its
 * API call is in flight, "completed" only when the real response
 * arrives (with a detail derived from that response), "failed" when
 * the call errors, and "skipped" for downstream stages after a failure
 * stops the run. Nothing here is timed or simulated.
 */

export type PipelineStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface PipelineStage {
  id: string;
  title: string;
  description: string;
  status: PipelineStageStatus;
  /** Response-derived detail, set when a stage completes or fails. */
  detail?: string;
}

/** Stage ids in execution order. */
export const PIPELINE_STAGE_ORDER: readonly string[] = [
  "understand-query",
  "plan-research",
  "search-sources",
  "analyze-evidence",
  "generate-problems",
  "analyze-gaps",
  "rank-problems",
];

export function createInitialPipelineStages(): PipelineStage[] {
  return [
    {
      id: "understand-query",
      title: "Understand Query",
      description:
        "The Intent/Scope Agent parses your question into intent, domain, and audience.",
      status: "pending",
    },
    {
      id: "plan-research",
      title: "Plan Research",
      description:
        "The Research Planner turns the validated scope into falsifiable hypotheses and search queries.",
      status: "pending",
    },
    {
      id: "search-sources",
      title: "Search Sources",
      description:
        "The Search Orchestrator runs the planned queries against real web sources.",
      status: "pending",
    },
    {
      id: "analyze-evidence",
      title: "Analyze Evidence",
      description:
        "The Evidence Analyzer classifies every retrieved source against its hypothesis.",
      status: "pending",
    },
    {
      id: "generate-problems",
      title: "Generate Candidate Problems",
      description:
        "The Problem Generator synthesizes evidence-grounded candidate problems.",
      status: "pending",
    },
    {
      id: "analyze-gaps",
      title: "Solutions & Gaps",
      description:
        "The Gap Analyzer finds the existing solutions and the unresolved gaps they leave.",
      status: "pending",
    },
    {
      id: "rank-problems",
      title: "Ranking",
      description:
        "The Problem Ranker deterministically scores the candidates by opportunity.",
      status: "pending",
    },
  ];
}
