"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, RotateCcw } from "lucide-react";

import { ResearchProgress } from "@/components/research-progress";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  createInitialPipelineStages,
  type PipelineStage,
  type PipelineStageStatus,
} from "@/lib/pipeline-stages";
import { saveRun, type PipelineResult } from "@/lib/pipeline-store";
import {
  requestEvidenceAnalysis,
  requestGapAnalysis,
  requestIntentScope,
  requestProblemGeneration,
  requestProblemRanking,
  requestResearchPlan,
  requestSearchRun,
} from "@/lib/api-client";
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
 * Silently stops a run that is no longer current (component
 * unmounted, or a newer run took over). Never surfaced to the UI.
 */
class RunInvalidated extends Error {}

/** Outputs of completed stages, carried across a retry. */
interface PartialRun {
  intent?: IntentScope;
  plan?: ResearchPlan;
  searchRun?: SearchRun;
  analysis?: EvidenceAnalysisRun;
  problemGeneration?: ProblemGenerationResult;
  gapAnalysis?: GapAnalysisResult;
}

function setStageStatus(
  stages: PipelineStage[],
  stageId: string,
  status: PipelineStageStatus,
  detail?: string
): PipelineStage[] {
  return stages.map((stage) =>
    stage.id === stageId
      ? { ...stage, status, detail: detail ?? stage.detail }
      : stage
  );
}

/** Reset the failed stage and everything downstream to pending. */
function resetIncompleteStages(stages: PipelineStage[]): PipelineStage[] {
  return stages.map((stage) =>
    stage.status === "completed"
      ? stage
      : { ...stage, status: "pending", detail: undefined }
  );
}

/** Mark the in-flight stage failed and bypass the rest. */
function markRunFailed(stages: PipelineStage[], message: string): PipelineStage[] {
  const failedIndex = stages.findIndex((stage) => stage.status === "running");
  if (failedIndex === -1) return stages;
  return stages.map((stage, index) => {
    if (index === failedIndex) {
      return { ...stage, status: "failed", detail: message };
    }
    if (index > failedIndex && stage.status === "pending") {
      return { ...stage, status: "skipped" };
    }
    return stage;
  });
}

// Stage details are derived only from the real responses.

function describeIntent(intent: IntentScope): string {
  return `Intent: ${intent.intent} · Domain: ${intent.domain} · Audience: ${intent.audience}`;
}

function describePlan(plan: ResearchPlan): string {
  return `${plan.hypotheses.length} research direction${
    plan.hypotheses.length === 1 ? "" : "s"
  } planned`;
}

function describeSearchRun(searchRun: SearchRun): string {
  const { budget_usage: budget, results } = searchRun;
  return `${budget.queries_executed}/${budget.total_query_budget} queries executed · ${results.length} source${
    results.length === 1 ? "" : "s"
  } found`;
}

function describeAnalysis(analysis: EvidenceAnalysisRun): string {
  const analyzed = analysis.hypotheses.filter(
    (hypothesis) => hypothesis.status === "analyzed"
  ).length;
  const sources = analysis.hypotheses.reduce(
    (sum, hypothesis) => sum + hypothesis.evidence.length,
    0
  );
  const observations = analysis.hypotheses.reduce(
    (sum, hypothesis) =>
      sum +
      hypothesis.evidence.reduce(
        (count, entry) => count + (entry.observations?.length ?? 0),
        0
      ),
    0
  );
  return `${analyzed}/${analysis.hypotheses.length} hypotheses analyzed · ${sources} sources · ${observations} observations`;
}

function describeProblemGeneration(result: ProblemGenerationResult): string {
  const observations = result.problems.reduce(
    (sum, problem) => sum + (problem.observations?.length ?? 0),
    0
  );
  return `${result.summary.candidate_problem_count} candidate problem${
    result.summary.candidate_problem_count === 1 ? "" : "s"
  } · ${observations} validated observations`;
}

function describeGapAnalysis(result: GapAnalysisResult): string {
  return `${result.summary.solution_count} existing solution${
    result.summary.solution_count === 1 ? "" : "s"
  } · ${result.summary.gap_count} unresolved gap${
    result.summary.gap_count === 1 ? "" : "s"
  }`;
}

function describeRanking(result: ProblemRankingResult): string {
  const rankable = result.ranked_problems.filter(
    (problem) => problem.rankable
  );
  if (rankable.length === 0) {
    return "no rankable candidates — insufficient gap evidence";
  }
  const top = rankable.reduce((best, problem) =>
    problem.opportunity_score > best.opportunity_score ? problem : best
  );
  return `${result.summary.rankable_count} rankable · top score ${Math.round(
    top.opportunity_score
  )}/100`;
}

function ResearchPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const query = searchParams.get("q") ?? "";

  const [stages, setStages] = useState<PipelineStage[]>(() =>
    createInitialPipelineStages()
  );
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const mountedRef = useRef(true);
  const runTokenRef = useRef(0);
  const startedQueryRef = useRef<string | null>(null);
  const runRef = useRef<{ runId: string; partial: PartialRun } | null>(null);

  const runPipeline = useCallback(
    async (queryText: string, restart: boolean) => {
      // A fresh run gets a new run id and no carried results; a
      // retry keeps the run id and every stage result already
      // completed, re-running only the stages that failed.
      if (restart || !runRef.current) {
        runRef.current = { runId: crypto.randomUUID(), partial: {} };
        setStages(createInitialPipelineStages());
      } else {
        setStages(resetIncompleteStages);
      }
      const run = runRef.current;
      const token = ++runTokenRef.current;
      const partial = run.partial;

      function assertActive(currentToken: number): void {
        if (!mountedRef.current || runTokenRef.current !== currentToken) {
          throw new RunInvalidated();
        }
      }

      /** Run one real stage: mark running, execute, mark completed with the response-derived detail. */
      async function runStage<T>(
        stageId: string,
        execute: () => Promise<T>,
        describe: (result: T) => string
      ): Promise<T> {
        setStages((prev) => setStageStatus(prev, stageId, "running"));
        const result = await execute();
        assertActive(token);
        setStages((prev) =>
          setStageStatus(prev, stageId, "completed", describe(result))
        );
        return result;
      }

      setError(null);
      setIsRunning(true);

      try {
        // Stage 1 — Understand Query: the Intent/Scope Agent (POST /api/intent).
        const intent =
          partial.intent ??
          (await runStage(
            "understand-query",
            () => requestIntentScope(queryText),
            describeIntent
          ));
        partial.intent = intent;

        // Stage 2 — Plan Research: the Research Planner (POST /api/plan).
        const plan =
          partial.plan ??
          (await runStage(
            "plan-research",
            () => requestResearchPlan(queryText, intent),
            describePlan
          ));
        partial.plan = plan;

        // Stage 3 — Search Sources: the Search Orchestrator (POST /api/search).
        const searchRun =
          partial.searchRun ??
          (await runStage(
            "search-sources",
            () => requestSearchRun(plan),
            describeSearchRun
          ));
        partial.searchRun = searchRun;

        // Stage 4 — Analyze Evidence: the Evidence Analyzer (POST /api/analyze).
        const analysis =
          partial.analysis ??
          (await runStage(
            "analyze-evidence",
            () => requestEvidenceAnalysis(plan, searchRun),
            describeAnalysis
          ));
        partial.analysis = analysis;

        // Stage 5 — Generate Candidate Problems: the Problem Generator (POST /api/generate-problems).
        const problemGeneration =
          partial.problemGeneration ??
          (await runStage(
            "generate-problems",
            () => requestProblemGeneration(plan, analysis),
            describeProblemGeneration
          ));
        partial.problemGeneration = problemGeneration;

        const candidates = problemGeneration.problems;

        // Stage 6 — Solutions & Gaps: the Gap Analyzer (POST /api/analyze-gaps).
        const gapAnalysis =
          partial.gapAnalysis ??
          (await runStage(
            "analyze-gaps",
            () => requestGapAnalysis(candidates),
            describeGapAnalysis
          ));
        partial.gapAnalysis = gapAnalysis;

        // Stage 7 — Ranking: the deterministic Problem Ranker (POST /api/rank-problems).
        const ranking = await runStage(
          "rank-problems",
          () => requestProblemRanking(candidates, gapAnalysis),
          describeRanking
        );

        // Persist the completed run, then open the real results by run id.
        const result: PipelineResult = {
          runId: run.runId,
          query: queryText,
          intent,
          plan,
          searchRun,
          analysis,
          problemGeneration,
          gapAnalysis,
          ranking,
        };
        saveRun(result);

        assertActive(token);
        setIsRunning(false);
        router.replace(
          `/results?q=${encodeURIComponent(queryText)}&run=${run.runId}`
        );
      } catch (err) {
        if (err instanceof RunInvalidated) return;
        const message =
          err instanceof Error
            ? err.message
            : "Something went wrong while running the research pipeline.";
        setStages((prev) => markRunFailed(prev, message));
        setError(message);
        setIsRunning(false);
      }
    },
    [router]
  );

  // Start the real pipeline once per query. There is no timed or
  // simulated progress anywhere — every stage transition below is
  // a real API response.
  useEffect(() => {
    mountedRef.current = true;
    const trimmed = query.trim();
    if (trimmed && startedQueryRef.current !== trimmed) {
      startedQueryRef.current = trimmed;
      void runPipeline(trimmed, true);
    }
    return () => {
      mountedRef.current = false;
      runTokenRef.current += 1;
      startedQueryRef.current = null;
    };
  }, [query, runPipeline]);

  if (!query.trim()) {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center px-6 py-12">
        <Link
          href="/"
          className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          New exploration
        </Link>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-lg">No research query</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This page runs the real research pipeline for a query. Enter a
              question on the home page to start.
            </p>
            <Button asChild>
              <Link href="/">Start an exploration</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center px-6 py-12">
      <Link
        href="/"
        className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        New exploration
      </Link>

      <ResearchProgress stages={stages} query={query || undefined} />

      {error ? (
        <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
          <p role="alert" className="text-sm font-medium text-destructive">
            Pipeline stage failed
          </p>
          <p className="mt-1 text-sm text-destructive/90">{error}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runPipeline(query.trim(), false)}
            >
              <RotateCcw className="size-3.5" />
              Retry failed stage
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void runPipeline(query.trim(), true)}
            >
              Start over
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ResearchPageFallback() {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center gap-4 px-6 py-12">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export default function ResearchPage() {
  return (
    <Suspense fallback={<ResearchPageFallback />}>
      <ResearchPageContent />
    </Suspense>
  );
}
