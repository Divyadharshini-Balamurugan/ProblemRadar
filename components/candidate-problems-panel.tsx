import { ExternalLink, Lightbulb } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CandidateProblem } from "@/types";

interface CandidateProblemsPanelProps {
  problems: CandidateProblem[];
}

function CandidateProblemCard({ problem }: { problem: CandidateProblem }) {
  const observations = problem.observations ?? [];

  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base leading-snug font-medium text-foreground/90">
            {problem.problem_statement}
          </CardTitle>
          <Badge
            variant="outline"
            className="shrink-0 font-normal text-muted-foreground"
          >
            {problem.evidence_strength} evidence
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Affected population</dt>
            <dd>{problem.affected_population}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Affected activity</dt>
            <dd>{problem.affected_activity}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Context</dt>
            <dd>{problem.context}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Mechanism</dt>
            <dd>{problem.mechanism}</dd>
          </div>
        </dl>

        <div>
          <p className="text-xs text-muted-foreground">Observed impact</p>
          <p className="mt-0.5 text-sm">{problem.observed_impact}</p>
        </div>

        {observations.length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">
              Validated observations ({observations.length})
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {observations.map((observation, index) => (
                <li key={`${observation.claim}-${index}`}>{observation.claim}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">
            Evidence ({problem.evidence_refs.length} source
            {problem.evidence_refs.length === 1 ? "" : "s"})
          </p>
          <ul className="space-y-2">
            {problem.evidence_refs.map((reference) => (
              <li
                key={reference.evidence_id}
                className="rounded-md border p-3 text-sm"
              >
                <a
                  href={reference.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-1.5 font-medium text-foreground hover:underline"
                >
                  {reference.title}
                  <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                </a>
                <p className="mt-0.5 text-muted-foreground">
                  {reference.evidence_summary}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary" className="font-normal">
                    {reference.source}
                  </Badge>
                  <span className="text-muted-foreground/70">
                    via &ldquo;{reference.query}&rdquo;
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Renders the Problem Generator's actual output (Stage 5 — the
 * `CandidateProblem[]` of the run's `ProblemGenerationResult`):
 * each candidate with its validated observations and the exact
 * retrieved sources backing it. Pure rendering — every string
 * comes verbatim from the pipeline response.
 */
export function CandidateProblemsPanel({
  problems,
}: CandidateProblemsPanelProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Lightbulb className="size-5 text-muted-foreground" />
          Candidate Problems
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Evidence-grounded candidate problems synthesized by the Problem
          Generator (Stage 5) — every claim traceable to the retrieved
          sources above.
        </p>
      </div>

      <div className="space-y-4">
        {problems.map((problem) => (
          <CandidateProblemCard key={problem.id} problem={problem} />
        ))}
      </div>
    </div>
  );
}
