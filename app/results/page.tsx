"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { EvidenceAnalysisPanel } from "@/components/evidence-analysis-panel";
import { ProblemCard } from "@/components/problem-card";
import { ResultsSummary } from "@/components/results-summary";
import { SearchResultsPanel } from "@/components/search-results-panel";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MOCK_PROBLEMS } from "@/lib/mock-data";
import { getPipelineResult, type PipelineResult } from "@/lib/pipeline-store";
import type { Problem, RecurrenceLevel } from "@/types";

type FilterKey = "all" | RecurrenceLevel;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
];

function problemsFor(filter: FilterKey, problems: Problem[]): Problem[] {
  if (filter === "all") return problems;
  return problems.filter((problem) => problem.recurrence === filter);
}

function ResultsPageContent() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";

  // Lazy-initialized so it's read exactly once, and safely: on a genuine
  // page reload the store is fresh (null) on both server and client, so
  // there's nothing to mismatch during hydration; on a normal client-side
  // navigation from "/" (the common case — see app/page.tsx) there's no
  // SSR pass for this transition at all, so the real value is picked up
  // immediately. This never re-fetches /api/intent, /api/plan, or
  // /api/search — it only reads what "/" already computed.
  const [pipeline] = useState<PipelineResult | null>(() => getPipelineResult());

  useEffect(() => {
    if (pipeline) {
      console.log("[ProblemRadar] Results: rendering pipeline result for query:", pipeline.query);
      console.log("[ProblemRadar] Results: SearchRun", pipeline.searchRun);
      console.log("[ProblemRadar] Results: EvidenceAnalysis", pipeline.analysis);
    } else {
      console.log("[ProblemRadar] Results: no pipeline result in this session — showing mock problems only.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto w-full max-w-[1040px] flex-1 px-6 py-10 sm:py-14">
      <Link
        href="/"
        className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        New exploration
      </Link>

      {pipeline ? (
        <>
          <SearchResultsPanel plan={pipeline.plan} searchRun={pipeline.searchRun} />
          <Separator className="my-10" />
          <EvidenceAnalysisPanel analysis={pipeline.analysis} />
          <Separator className="my-10" />
          <p className="mb-3 text-sm text-muted-foreground">
            Discovered problems below are still illustrative mock data — problem detection and ranking from
            the evidence analysis above are a future stage.
          </p>
        </>
      ) : null}

      <ResultsSummary problems={MOCK_PROBLEMS} query={query || undefined} />

      <Tabs defaultValue="all" className="mt-8">
        <TabsList>
          {FILTERS.map((filter) => (
            <TabsTrigger key={filter.key} value={filter.key}>
              {filter.label} ({problemsFor(filter.key, MOCK_PROBLEMS).length})
            </TabsTrigger>
          ))}
        </TabsList>

        {FILTERS.map((filter) => {
          const filtered = problemsFor(filter.key, MOCK_PROBLEMS);
          return (
            <TabsContent key={filter.key} value={filter.key} className="mt-6">
              {filtered.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  {filtered.map((problem) => (
                    <ProblemCard key={problem.id} problem={problem} />
                  ))}
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No problems match this filter yet.
                </p>
              )}
            </TabsContent>
          );
        })}
      </Tabs>
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
