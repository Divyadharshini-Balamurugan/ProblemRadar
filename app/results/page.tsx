"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, SearchX } from "lucide-react";

import { CandidateProblemsPanel } from "@/components/candidate-problems-panel";
import { EvidenceAnalysisPanel } from "@/components/evidence-analysis-panel";
import { FinalResultPanel } from "@/components/final-result-panel";
import { SearchResultsPanel } from "@/components/search-results-panel";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { getRun, type PipelineResult } from "@/lib/pipeline-store";

/** No candidates were generated in this run — shown instead of mock cards. */
function NoProblemsFound() {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <SearchX className="size-5 text-muted-foreground" />
          No problems found
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          The Problem Generator found no evidence-grounded candidate problems
          in this run — the retrieved sources didn&rsquo;t support any concrete
          problem statements.
        </p>
      </CardContent>
    </Card>
  );
}

/** The requested run isn't in this session's registry. */
function NoResearchResult() {
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
          <CardTitle className="flex items-center gap-2 text-lg">
            <SearchX className="size-5 text-muted-foreground" />
            No research result in this session
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Completed runs are kept for this browser tab only — this project
            has no server-side storage yet. Run a research from the home page
            and its real results will load here by run id.
          </p>
          <Button asChild>
            <Link href="/">Start an exploration</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ResultsPageContent() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const runId = searchParams.get("run") ?? "";

  // Read exactly once: the research page saves the completed run
  // under its run id (see lib/pipeline-store.ts) before navigating
  // here, so this page renders that run's actual pipeline
  // responses — nothing is re-derived, and nothing falls back to
  // sample data.
  const [run, setRun] = useState<PipelineResult | null>(null);
  const [hasLoadedRun, setHasLoadedRun] = useState(false);

  // Browser storage is read after hydration, keeping server and first
  // client renders identical when this page is reloaded directly.
  useEffect(() => {
    setRun(runId ? getRun(runId) : null);
    setHasLoadedRun(true);
  }, [runId]);

  if (!hasLoadedRun) {
    return <ResultsPageFallback />;
  }

  if (!run) {
    return <NoResearchResult />;
  }

  const candidates = run.problemGeneration.problems;

  return (
    <div className="mx-auto w-full max-w-[1040px] flex-1 px-6 py-10 sm:py-14">
      <Link
        href="/"
        className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        New exploration
      </Link>

      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Results for &ldquo;{run.query}&rdquo;
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every section below renders the actual responses of run{" "}
          <span className="font-mono text-xs">{run.runId}</span> — search
          evidence, analyzed sources, generated candidates, and the ranked
          opportunities.
        </p>
      </header>

      <SearchResultsPanel plan={run.plan} searchRun={run.searchRun} />
      <Separator className="my-10" />
      <EvidenceAnalysisPanel analysis={run.analysis} />
      <Separator className="my-10" />
      {candidates.length > 0 ? (
        <>
          <CandidateProblemsPanel problems={candidates} />
          <Separator className="my-10" />
        </>
      ) : (
        <NoProblemsFound />
      )}
      <FinalResultPanel ranking={run.ranking} />
    </div>
  );
}

function ResultsPageFallback() {
  return (
    <div className="mx-auto w-full max-w-[1040px] flex-1 space-y-4 px-6 py-10 sm:py-14">
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={<ResultsPageFallback />}>
      <ResultsPageContent />
    </Suspense>
  );
}
