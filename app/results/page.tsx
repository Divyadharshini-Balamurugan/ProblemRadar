"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { ProblemCard } from "@/components/problem-card";
import { ResultsSummary } from "@/components/results-summary";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MOCK_PROBLEMS } from "@/lib/mock-data";
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

  return (
    <div className="mx-auto w-full max-w-[1040px] flex-1 px-6 py-10 sm:py-14">
      <Link
        href="/"
        className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        New exploration
      </Link>

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
