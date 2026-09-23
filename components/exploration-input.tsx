"use client";

import type { KeyboardEvent } from "react";
import { ArrowRight, Loader2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ExplorationInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Label of the currently active Quick Start option or chip, if any. */
  activeContextLabel?: string | null;
  onClearContext?: () => void;
  placeholder?: string;
  isSubmitting?: boolean;
  className?: string;
}

/**
 * The primary natural-language input for a ProblemRadar exploration.
 * Selecting a Quick Start option only guides this input (via
 * `activeContextLabel` / prefilled `value`) — it never locks the user
 * out of typing whatever they want.
 */
export function ExplorationInput({
  value,
  onChange,
  onSubmit,
  activeContextLabel,
  onClearContext,
  placeholder = "Find real problems people are facing...",
  isSubmitting = false,
  className,
}: ExplorationInputProps) {
  const canSubmit = value.trim().length > 0 && !isSubmitting;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  return (
    <Card className={cn("gap-0 p-5 shadow-sm sm:p-6", className)}>
      {activeContextLabel ? (
        <div className="mb-3 flex items-center gap-2">
          <Badge variant="secondary" className="gap-1.5 py-1 pl-2.5 pr-1.5">
            {activeContextLabel}
            {onClearContext ? (
              <button
                type="button"
                onClick={onClearContext}
                aria-label="Clear guided context"
                className="rounded-sm p-0.5 outline-none hover:bg-background/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </Badge>
        </div>
      ) : null}

      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label="Describe what you want to discover"
        className="min-h-36 resize-none border-none px-1 text-base shadow-none focus-visible:ring-0 sm:min-h-44 sm:text-lg"
        autoFocus
      />

      <div className="mt-4 flex items-center justify-between gap-3 border-t pt-4">
        <p className="hidden text-xs text-muted-foreground sm:block">
          Press{" "}
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            ⌘
          </kbd>{" "}
          +{" "}
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            Enter
          </kbd>{" "}
          to search
        </p>
        <Button
          size="lg"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="ml-auto"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="animate-spin" />
              Discovering...
            </>
          ) : (
            <>
              Discover Problems
              <ArrowRight />
            </>
          )}
        </Button>
      </div>
    </Card>
  );
}
