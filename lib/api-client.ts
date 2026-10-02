import type { CandidateProblem, EvidenceAnalysisRun, GapAnalysisResult, IntentScope, ProblemGenerationResult, ResearchPlan, SearchRun } from "@/types";

interface IntentApiResponse {
  ok: boolean;
  intent?: IntentScope;
  error?: string;
}

interface PlanApiResponse {
  ok: boolean;
  plan?: ResearchPlan;
  error?: string;
}

interface SearchApiResponse {
  ok: boolean;
  run?: SearchRun;
  error?: string;
}

interface AnalyzeApiResponse {
  ok: boolean;
  analysis?: EvidenceAnalysisRun;
  error?: string;
}

interface ProblemGenerationApiResponse {
  ok: boolean;
  result?: ProblemGenerationResult;
  error?: string;
}

/**
 * Client-side call to the Intent/Scope Agent (POST /api/intent). Kept in
 * one place so the page component doesn't know about fetch/response
 * shapes directly — if the endpoint or its payload changes later, only
 * this function needs to change.
 */
export async function requestIntentScope(query: string): Promise<IntentScope> {
  const response = await fetch("/api/intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const data = (await response.json().catch(() => null)) as IntentApiResponse | null;

  if (!response.ok || !data?.ok || !data.intent) {
    throw new Error(
      data?.error ?? "The Intent/Scope Agent could not process this request."
    );
  }

  return data.intent;
}

/**
 * Client-side call to the Research Planner (POST /api/plan). Takes the
 * already-validated `IntentScope` from `requestIntentScope` — this stage
 * never re-derives scope from the raw query itself. `query` is passed
 * along only so the server's console log for this stage is self-explanatory.
 */
export async function requestResearchPlan(
  query: string,
  intent: IntentScope
): Promise<ResearchPlan> {
  const response = await fetch("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, intent }),
  });

  const data = (await response.json().catch(() => null)) as PlanApiResponse | null;

  if (!response.ok || !data?.ok || !data.plan) {
    throw new Error(
      data?.error ?? "The Research Planner could not process this request."
    );
  }

  return data.plan;
}

/**
 * Client-side call to the Search Orchestrator (POST /api/search). Takes
 * the exact `ResearchPlan` returned by `requestResearchPlan` — this stage
 * never regenerates or re-derives the plan, and never calls an LLM; it
 * only forwards the already-validated plan to the existing
 * `runSearchOrchestrator()` pipeline (via the route) and returns the
 * resulting `SearchRun` (normalized results, execution log, and budget
 * usage) unmodified.
 */
export async function requestSearchRun(plan: ResearchPlan): Promise<SearchRun> {
  const response = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });

  const data = (await response.json().catch(() => null)) as SearchApiResponse | null;

  if (!response.ok || !data?.ok || !data.run) {
    throw new Error(
      data?.error ?? "The Search Orchestrator could not process this request."
    );
  }

  return data.run;
}

/**
 * Client-side call to the Evidence Analyzer (POST /api/analyze). Takes
 * the exact `ResearchPlan` and `SearchRun` already produced by the
 * earlier stages — this stage never re-plans or re-searches, and never
 * duplicates `runEvidenceAnalyzer()`'s own logic here; it only forwards
 * both, already-validated, to the existing pipeline (via the route) and
 * returns the resulting `EvidenceAnalysisRun` (per-hypothesis, per-source
 * stance/relevance/recency/evidence, with any per-hypothesis failures
 * already recorded rather than thrown) unmodified.
 */
export async function requestEvidenceAnalysis(plan: ResearchPlan, run: SearchRun): Promise<EvidenceAnalysisRun> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan, run }),
  });

  const data = (await response.json().catch(() => null)) as AnalyzeApiResponse | null;

  if (!response.ok || !data?.ok || !data.analysis) {
    throw new Error(
      data?.error ?? "The Evidence Analyzer could not process this request."
    );
  }

  return data.analysis;
}

/** Client-side call to Gap Analysis (POST /api/analyze-gaps). */
export async function requestGapAnalysis(problems: CandidateProblem[]): Promise<GapAnalysisResult> {
  const response = await fetch("/api/analyze-gaps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ problems }),
  });
  const data = (await response.json().catch(() => null)) as { ok: boolean; result?: GapAnalysisResult; error?: string } | null;
  if (!response.ok || !data?.ok || !data.result) {
    throw new Error(data?.error ?? "Gap Analysis could not process this request.");
  }
  return data.result;
}

/** Client-side call to Problem Generator (POST /api/generate-problems). */
export async function requestProblemGeneration(
  plan: ResearchPlan,
  analysis: EvidenceAnalysisRun
): Promise<ProblemGenerationResult> {
  const response = await fetch("/api/generate-problems", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan, analysis }),
  });
  const data = (await response.json().catch(() => null)) as ProblemGenerationApiResponse | null;
  if (!response.ok || !data?.ok || !data.result) {
    throw new Error(data?.error ?? "The Problem Generator could not process this request.");
  }
  return data.result;
}
