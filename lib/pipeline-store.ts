import type {
  EvidenceAnalysisRun,
  GapAnalysisResult,
  IntentScope,
  ProblemGenerationResult,
  ProblemRankingResult,
  ResearchPlan,
  SearchRun,
} from "@/types";

/**
 * Registry of completed pipeline runs, keyed by run id.
 *
 * The research page generates a run id (`crypto.randomUUID()`) when a
 * pipeline starts, executes the real stages, saves the completed run
 * here, and navigates to `/results?...&run=<runId>`. The results page
 * loads the run by that id, so the URL — not component-tree memory —
 * identifies what to render.
 *
 * Runs are kept in memory for fast route transitions and mirrored to
 * sessionStorage so a completed run survives refreshes in the same tab.
 */
export interface PipelineResult {
  /** Stable id for this run — generated when the pipeline starts. */
  runId: string;
  query: string;
  intent: IntentScope;
  plan: ResearchPlan;
  searchRun: SearchRun;
  analysis: EvidenceAnalysisRun;
  problemGeneration: ProblemGenerationResult;
  gapAnalysis: GapAnalysisResult;
  ranking: ProblemRankingResult;
}

const runs = new Map<string, PipelineResult>();
const STORAGE_PREFIX = "problem-radar:run:";

export function saveRun(result: PipelineResult): void {
  runs.set(result.runId, result);
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(
      `${STORAGE_PREFIX}${result.runId}`,
      JSON.stringify(result)
    );
  } catch (error) {
    // Keep navigation functional if storage is blocked or the tab is out of space.
    console.warn("[ProblemRadar] Could not save the run to session storage.", error);
  }
}

export function getRun(runId: string): PipelineResult | null {
  const inMemory = runs.get(runId);
  if (inMemory) return inMemory;
  if (typeof window === "undefined") return null;

  try {
    const serialized = window.sessionStorage.getItem(`${STORAGE_PREFIX}${runId}`);
    if (!serialized) return null;
    const result = JSON.parse(serialized) as PipelineResult;
    if (result.runId !== runId) return null;
    runs.set(runId, result);
    return result;
  } catch (error) {
    console.warn("[ProblemRadar] Could not restore the run from session storage.", error);
    return null;
  }
}

export function clearRuns(): void {
  runs.clear();
  if (typeof window === "undefined") return;

  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => window.sessionStorage.removeItem(key));
  } catch (error) {
    console.warn("[ProblemRadar] Could not clear saved runs from session storage.", error);
  }
}
