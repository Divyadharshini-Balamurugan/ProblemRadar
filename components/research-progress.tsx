import { CheckCircle2, CircleDashed, LoaderCircle } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { RESEARCH_STAGES } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import type { ResearchStage } from "@/types";

interface ResearchProgressProps {
  stages?: ResearchStage[];
  query?: string;
  className?: string;
}

function stageProgress(stages: ResearchStage[]) {
  const weight = { complete: 1, active: 0.5, pending: 0 } as const;
  const total = stages.reduce((sum, stage) => sum + weight[stage.status], 0);
  return Math.round((total / stages.length) * 100);
}

/**
 * Reusable research-state UI. Renders whatever stages/status it is given,
 * so wiring in a live research engine later just means streaming real
 * `ResearchStage[]` updates into this component instead of the mock list.
 */
export function ResearchProgress({
  stages = RESEARCH_STAGES,
  query,
  className,
}: ResearchProgressProps) {
  const percent = stageProgress(stages);

  return (
    <Card className={cn("gap-5", className)}>
      <CardHeader>
        <CardTitle className="text-lg">Researching your request</CardTitle>
        {query ? (
          <CardDescription className="line-clamp-2">
            &ldquo;{query}&rdquo;
          </CardDescription>
        ) : (
          <CardDescription>
            This runs through several stages before results are ready.
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Progress value={percent} />
          <p className="text-xs text-muted-foreground">{percent}% complete</p>
        </div>

        <ol className="space-y-0">
          {stages.map((stage, index) => {
            const isLast = index === stages.length - 1;
            return (
              <li key={stage.id} className="relative flex gap-3 pb-6 last:pb-0">
                {!isLast ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-6 left-[11px] h-full w-px",
                      stage.status === "complete" ? "bg-primary/40" : "bg-border"
                    )}
                  />
                ) : null}

                <span className="relative z-10 mt-0.5 shrink-0">
                  {stage.status === "complete" ? (
                    <CheckCircle2 className="size-[22px] text-primary" />
                  ) : stage.status === "active" ? (
                    <LoaderCircle className="size-[22px] animate-spin text-primary" />
                  ) : (
                    <CircleDashed className="size-[22px] text-muted-foreground/50" />
                  )}
                </span>

                <div className="pt-px">
                  <p
                    className={cn(
                      "text-base font-medium",
                      stage.status === "pending" && "text-muted-foreground"
                    )}
                  >
                    {stage.title}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {stage.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
