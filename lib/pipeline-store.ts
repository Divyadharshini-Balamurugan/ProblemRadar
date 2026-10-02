import type { EvidenceAnalysisRun, IntentScope, ProblemGenerationResult, ResearchPlan, SearchRun } from "@/types";

/**
 * Hands the completed Stage 1 → 2 → 3 → 4 pipeline result from the
 * workspace page (`/`, where all four stages actually run — see
 * `app/page.tsx`) across a client-side route change to `/results`,
 * without re-fetching or re-deriving anything there.
 *
 * This is deliberately NOT a state-management library or a React context
 * — just a plain module-level value with a getter/setter, the smallest
 * thing that can survive a route change within the same browser tab.
 * (Next.js App Router client-side navigation keeps the JS module registry
 * alive; only a full page reload resets it, at which point both server
 * and client render from `null` consistently, so there's no hydration
 * mismatch risk.) There's still no database or persistence layer — this
 * intentionally does not survive a reload, matching the rest of the app.
 */
export interface PipelineResult {
  query: string;
  intent: IntentScope;
  plan: ResearchPlan;
  searchRun: SearchRun;
  analysis: EvidenceAnalysisRun;
  problemGeneration: ProblemGenerationResult;
}

let latestPipelineResult: PipelineResult | null = null;

export function setPipelineResult(result: PipelineResult): void {
  latestPipelineResult = result;
}

export function getPipelineResult(): PipelineResult | null {
  return latestPipelineResult;
}
