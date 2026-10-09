import { AlertCircle, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  coverageLabel,
  formatOpportunityScore,
  gapConfidenceLabel,
  rankedOpportunities,
  scoreBarWidth,
  sortedComponents,
  summarizeRanking,
} from "@/lib/final-result";
import type { ProblemRankingResult, RankedCandidateProblem } from "@/types";

interface FinalResultPanelProps {
  ranking: ProblemRankingResult;
}

function ScoreBar({ score, maxScore }: { score: number; maxScore: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary"
        style={{ width: `${scoreBarWidth(score, maxScore)}%` }}
      />
    </div>
  );
}

function RankedProblemCard({
  problem,
  rank,
}: {
  problem: RankedCandidateProblem;
  rank: number;
}) {
  const components = sortedComponents(problem);
  const candidate = problem.candidate_problem;
  const gap = problem.gap_analysis;

  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-base font-semibold text-primary-foreground">
              {rank}
            </span>
            <CardTitle className="text-base leading-snug font-medium text-foreground/90">
              {problem.problem_statement}
            </CardTitle>
          </div>
          <Badge
            variant="secondary"
            className="shrink-0 whitespace-nowrap font-semibold"
          >
            {formatOpportunityScore(problem.opportunity_score)}
          </Badge>
        </div>
        <CardDescription>
          {candidate.affected_population} — {candidate.affected_activity}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            Opportunity score
          </p>
          {components.slice(0, 4).map((component) => (
            <div key={component.name} className="space-y-1">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium">{component.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {component.score}/{component.max_score}
                </span>
              </div>
              <ScoreBar score={component.score} maxScore={component.max_score} />
            </div>
          ))}
        </div>

        {gap ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-normal">
              {coverageLabel(gap.solution_coverage)}
            </Badge>
            <Badge variant="outline" className="font-normal">
              {gapConfidenceLabel(gap.gap_confidence)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {gap.existing_solutions.length} existing solution
              {gap.existing_solutions.length === 1 ? "" : "s"} ·{" "}
              {gap.unresolved_gaps.length} unresolved gap
              {gap.unresolved_gaps.length === 1 ? "" : "s"}
            </span>
          </div>
        ) : null}

        {gap && gap.unresolved_gaps.length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Unresolved gaps
            </p>
            <ul className="space-y-2">
              {gap.unresolved_gaps.map((unresolved, index) => (
                <li key={index} className="rounded-md border p-3 text-sm">
                  <p className="font-medium">{unresolved.gap}</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {unresolved.explanation}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {candidate.evidence_refs.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Grounded in {candidate.evidence_refs.length} retrieved source
            {candidate.evidence_refs.length === 1 ? "" : "s"}
            {candidate.observations && candidate.observations.length > 0
              ? ` and ${candidate.observations.length} validated observation${
                  candidate.observations.length === 1 ? "" : "s"
                }`
              : ""}
            .
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Renders the Problem Ranker's actual output (Stage 7 — the run's
 * `ProblemRankingResult`): the ranked opportunities with their
 * transparent component scores, plus the gap evidence behind them.
 * When no candidate is rankable, it says so with the real
 * rankability reasons instead of inventing a winner.
 */
export function FinalResultPanel({ ranking }: FinalResultPanelProps) {
  const ranked = rankedOpportunities(ranking);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <TrendingUp className="size-5 text-muted-foreground" />
          Ranked Opportunities
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {summarizeRanking(ranking)}
        </p>
      </div>

      {ranked.length === 0 ? (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertCircle className="size-5 text-muted-foreground" />
              No rankable problems
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The Problem Ranker found no candidate with sufficient gap evidence
              to prioritize — no winner is manufactured.
            </p>
            {ranking.ranked_problems.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {ranking.ranked_problems.map((problem) => (
                  <li key={problem.candidate_problem_id}>
                    <span className="font-medium text-foreground/80">
                      {problem.problem_statement}
                    </span>
                    {" — "}
                    {problem.rankability_reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No candidate problems were produced in this run.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {ranked.map((problem) => (
            <RankedProblemCard
              key={problem.candidate_problem_id}
              problem={problem}
              rank={problem.rank ?? 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
