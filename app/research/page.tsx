"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { ResearchProgress } from "@/components/research-progress";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RESEARCH_STAGES } from "@/lib/mock-data";
import type { ResearchStage } from "@/types";

/** Advance one stage roughly every 900ms — purely cosmetic, no real work happens. */
const STAGE_INTERVAL_MS = 900;

function withStatusAt(stages: ResearchStage[], activeIndex: number): ResearchStage[] {
  return stages.map((stage, index) => ({
    ...stage,
    status:
      index < activeIndex
        ? "complete"
        : index === activeIndex
          ? "active"
          : "pending",
  }));
}

function ResearchPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const query = searchParams.get("q") ?? "";

  const [stages, setStages] = useState<ResearchStage[]>(() =>
    withStatusAt(RESEARCH_STAGES, 0)
  );
  const [isDone, setIsDone] = useState(false);

  useEffect(() => {
    let activeIndex = 0;
    const timer = window.setInterval(() => {
      activeIndex += 1;
      if (activeIndex >= RESEARCH_STAGES.length) {
        setStages(RESEARCH_STAGES.map((stage) => ({ ...stage, status: "complete" })));
        setIsDone(true);
        window.clearInterval(timer);
        return;
      }
      setStages(withStatusAt(RESEARCH_STAGES, activeIndex));
    }, STAGE_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

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

      <div className="mt-6 flex justify-center">
        <Button
          size="lg"
          disabled={!isDone}
          onClick={() => router.push(`/results?q=${encodeURIComponent(query)}`)}
        >
          View Results
          <ArrowRight />
        </Button>
      </div>
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
