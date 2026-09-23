"use client";

import { useState } from "react";
import { ChevronDown, FileSearch, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { Problem, RecurrenceLevel } from "@/types";

const RECURRENCE_LABEL: Record<RecurrenceLevel, string> = {
  high: "High recurrence",
  medium: "Medium recurrence",
  low: "Low recurrence",
};

const RECURRENCE_BADGE_VARIANT: Record<
  RecurrenceLevel,
  "success" | "secondary" | "outline"
> = {
  high: "success",
  medium: "secondary",
  low: "outline",
};

interface ProblemCardProps {
  problem: Problem;
  className?: string;
}

/**
 * Reusable card for a single discovered problem. Renders from a `Problem`
 * object only — no data fetching — so it works the same against mock
 * data today or real API results later.
 */
export function ProblemCard({ problem, className }: ProblemCardProps) {
  const [showEvidence, setShowEvidence] = useState(false);

  return (
    <Card className={cn("gap-5", className)}>
      <CardHeader>
        <CardTitle className="text-lg leading-snug">
          {problem.title}
        </CardTitle>
        <CardAction>
          <Badge variant={RECURRENCE_BADGE_VARIANT[problem.recurrence]}>
            <TrendingUp />
            {RECURRENCE_LABEL[problem.recurrence]}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <CardDescription className="text-sm leading-relaxed text-foreground/80">
          {problem.description}
        </CardDescription>

        <div className="flex flex-wrap gap-1.5">
          {problem.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="font-normal text-muted-foreground">
              {tag}
            </Badge>
          ))}
        </div>

        <Separator />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>
              Mentioned in{" "}
              <span className="font-medium text-foreground">
                {problem.recurrenceCount}
              </span>{" "}
              places
            </span>
            <span className="flex items-center gap-1">
              <FileSearch className="size-3.5" />
              {problem.evidenceCount} evidence sources
            </span>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowEvidence((prev) => !prev)}
            aria-expanded={showEvidence}
          >
            View Evidence
            <ChevronDown
              className={cn(
                "transition-transform",
                showEvidence && "rotate-180"
              )}
            />
          </Button>
        </div>

        {showEvidence ? (
          <ul className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            {problem.sources.map((source) => (
              <li key={source.id} className="flex items-start gap-2">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                {source.label}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
