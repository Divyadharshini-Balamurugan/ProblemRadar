"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Radar } from "lucide-react";

import { ExplorationInput } from "@/components/exploration-input";
import { QuickStartOptions } from "@/components/quick-start-options";
import { Badge } from "@/components/ui/badge";
import { requestEvidenceAnalysis, requestIntentScope, requestResearchPlan, requestSearchRun } from "@/lib/api-client";
import { setPipelineResult } from "@/lib/pipeline-store";
import type { ExplorationChip, ExplorationContext, QuickStartOption } from "@/types";

export default function Home() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [context, setContext] = useState<ExplorationContext>({
    optionId: null,
    chipId: null,
  });
  const [contextLabel, setContextLabel] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  function handleSelectOption(option: QuickStartOption) {
    setValue(option.promptHint);
    setContext({ optionId: option.id, chipId: null });
    setContextLabel(option.title);
  }

  function handleSelectChip(chip: ExplorationChip) {
    setValue(chip.promptPrefix);
    setContext({ optionId: null, chipId: chip.id });
    setContextLabel(chip.label);
  }

  function handleClearContext() {
    setContext({ optionId: null, chipId: null });
    setContextLabel(null);
  }

  async function handleSubmit() {
    const query = value.trim();
    // `isSubmitting` guards the entire sequential Intent → Plan → Search
    // chain below in one gesture: it's set the moment this fires and only
    // ever cleared on failure (success navigates away instead), and this
    // function only ever runs from a user click/keydown — never from a
    // useEffect — so there is no path (re-render, prop change, remount)
    // that can invoke it, or the /api/search call inside it, more than
    // once per submission.
    if (!query || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      // Stage 1: understand the request.
      // See lib/llm/intent-agent.ts and app/api/intent/route.ts.
      setStatusMessage("Understanding your request…");
      console.log("[ProblemRadar] Pipeline — Intent → Plan → Search → Analyze → Results");
      console.log("[ProblemRadar] Intent: requesting Intent/Scope for query:", query);
      const intent = await requestIntentScope(query);
      console.log("[ProblemRadar] Intent: result", intent);

      // Stage 2: plan what to research. Kept as a separate call/module —
      // see lib/llm/research-planner.ts and app/api/plan/route.ts. Still
      // no web search/SerpApi/investigation happens here.
      setStatusMessage("Planning your research…");
      console.log("[ProblemRadar] Plan: requesting ResearchPlan from validated Intent/Scope");
      const plan = await requestResearchPlan(query, intent);
      console.log("[ProblemRadar] Plan: result", plan);

      // Stage 3: run the exact plan just received through the existing
      // Search Orchestrator (see lib/search/search-orchestrator.ts and
      // app/api/search/route.ts) — this never regenerates the plan, never
      // calls an LLM, and never duplicates the orchestrator's budget/
      // dedup/error-handling logic here; it only forwards `plan` as-is
      // and waits for the resulting SearchRun.
      setStatusMessage("Searching sources…");
      console.log("[ProblemRadar] Search: sending ResearchPlan to /api/search");
      const searchRun = await requestSearchRun(plan);
      console.log("[ProblemRadar] Search: result", searchRun);

      // Stage 4: run the exact plan + SearchRun just received through the
      // existing Evidence Analyzer (see lib/llm/evidence-analyzer.ts and
      // app/api/analyze/route.ts) — this never re-plans, never re-searches,
      // and never duplicates the analyzer's own classification/validation
      // logic here; it only forwards `plan` and `searchRun` as-is and
      // waits for the resulting EvidenceAnalysisRun. Runs exactly once per
      // submission, for the same structural reason stage 3 does: this
      // whole chain is inside one `isSubmitting`-guarded, click-triggered
      // handler, never a `useEffect`.
      setStatusMessage("Analyzing evidence…");
      console.log("[ProblemRadar] Analyze: sending ResearchPlan + SearchRun to /api/analyze");
      const analysis = await requestEvidenceAnalysis(plan, searchRun);
      console.log("[ProblemRadar] Analyze: result", analysis);

      // Stage 5: hand everything off to the results page/state — no
      // route reads this back over the network, it's the same completed
      // pipeline result, just passed along for /results to render.
      setPipelineResult({ query, intent, plan, searchRun, analysis });
      console.log("[ProblemRadar] Results: pipeline complete, navigating to /results via /research");

      router.push(`/research?q=${encodeURIComponent(query)}`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong while preparing research for your request."
      );
      setIsSubmitting(false);
      setStatusMessage(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-1 flex-col items-center px-6 py-12 sm:py-16">
      <div className="mb-8 flex flex-col items-center gap-3.5 text-center">
        <Badge variant="outline" className="gap-1.5 py-1 text-muted-foreground">
          <Radar className="size-3.5" />
          ProblemRadar Workspace
        </Badge>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          What do you want to discover?
        </h1>
        <p className="max-w-xl text-base text-muted-foreground sm:text-lg">
          Describe a person, an industry, or a problem — ProblemRadar
          searches real sources for evidence before you build anything.
        </p>
      </div>

      <ExplorationInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        activeContextLabel={contextLabel}
        onClearContext={handleClearContext}
        isSubmitting={isSubmitting}
        className="w-full"
      />

      {isSubmitting && statusMessage ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-3 flex w-full items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Loader2 className="size-3.5 animate-spin" />
          {statusMessage}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-3 w-full text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-8 w-full">
        <p className="mb-3.5 text-sm font-medium text-muted-foreground">
          Quick Start
        </p>
        <QuickStartOptions
          selectedOptionId={context.optionId}
          onSelectOption={handleSelectOption}
          onSelectChip={handleSelectChip}
        />
      </div>
    </div>
  );
}
