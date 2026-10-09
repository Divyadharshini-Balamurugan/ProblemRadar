import {
  CheckCircle2,
  CircleDashed,
  LoaderCircle,
  MinusCircle,
  XCircle,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type {
  PipelineStage,
  PipelineStageStatus,
} from "@/lib/pipeline-stages";

interface ResearchProgressProps {
  stages: PipelineStage[];
  query?: string;
  className?: string;
}

const STATUS_WEIGHT: Record<PipelineStageStatus, number> = {
  pending: 0,
  running: 0.5,
  completed: 1,
  failed: 0,
  skipped: 0,
};

function stageProgress(stages: PipelineStage[]): number {
  const total = stages.reduce((sum, stage) => sum + STATUS_WEIGHT[stage.status], 0);
  return Math.round((total / stages.length) * 100);
}

function StageIcon({ status }: { status: PipelineStageStatus }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-[22px] text-primary" />;
    case "running":
      return <LoaderCircle className="size-[22px] animate-spin text-primary" />;
    case "failed":
      return <XCircle className="size-[22px] text-destructive" />;
    case "skipped":
      return <MinusCircle className="size-[22px] text-muted-foreground/50" />;
    default:
      return <CircleDashed className="size-[22px] text-muted-foreground/50" />;
  }
}

/**
 * Research-state UI driven entirely by real pipeline execution.
 * Every status transition it renders — pending → running →
 * completed / failed, plus skipped for stages a failure bypassed
 * — is produced by the actual stage-by-stage API calls on the
 * research page; `detail` lines quote the real responses.
 */
export function ResearchProgress({
  stages,
  query,
  className,
}: ResearchProgressProps) {
  const percent = stageProgress(stages);
  const completedCount = stages.filter(
    (stage) => stage.status === "completed"
  ).length;

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
          <p className="text-xs text-muted-foreground">
            {completedCount} of {stages.length} stages complete — {percent}%
          </p>
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
                      stage.status === "completed"
                        ? "bg-primary/40"
                        : "bg-border"
                    )}
                  />
                ) : null}

                <span className="relative z-10 mt-0.5 shrink-0">
                  <StageIcon status={stage.status} />
                </span>

                <div className="pt-px">
                  <p
                    className={cn(
                      "text-base font-medium",
                      (stage.status === "pending" ||
                        stage.status === "skipped") &&
                        "text-muted-foreground"
                    )}
                  >
                    {stage.title}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {stage.description}
                  </p>
                  {stage.detail ? (
                    <p
                      className={cn(
                        "mt-0.5 text-sm",
                        stage.status === "failed"
                          ? "text-destructive"
                          : "text-foreground/80"
                      )}
                    >
                      {stage.detail}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
