/**
 * Types for the research-in-progress UI. Stages are mock/static for the
 * MVP UI but modeled the way the future research engine will report
 * real-time progress, so wiring in live status later is a data change,
 * not a UI rewrite.
 */

export type ResearchStageStatus = "pending" | "active" | "complete";

export interface ResearchStage {
  id: string;
  title: string;
  description: string;
  status: ResearchStageStatus;
}
