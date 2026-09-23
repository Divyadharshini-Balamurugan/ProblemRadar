"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Radar } from "lucide-react";

import { ExplorationInput } from "@/components/exploration-input";
import { QuickStartOptions } from "@/components/quick-start-options";
import { Badge } from "@/components/ui/badge";
import type { ExplorationChip, ExplorationContext, QuickStartOption } from "@/types";

export default function Home() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [context, setContext] = useState<ExplorationContext>({
    optionId: null,
    chipId: null,
  });
  const [contextLabel, setContextLabel] = useState<string | null>(null);

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

  function handleSubmit() {
    const query = value.trim();
    if (!query) return;
    router.push(`/research?q=${encodeURIComponent(query)}`);
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
        className="w-full"
      />

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
