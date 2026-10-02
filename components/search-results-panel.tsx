import { AlertTriangle, ExternalLink, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { ResearchPlan, SearchResult, SearchRun } from "@/types";

interface SearchResultsPanelProps {
  plan: ResearchPlan;
  searchRun: SearchRun;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function domainOf(result: SearchResult): string {
  return result.source || result.url;
}

/**
 * Renders the Search Orchestrator's output (Stage 3 — `SearchRun`) on the
 * results page: real, normalized web-search evidence, grouped by the
 * hypothesis it was found for, plus the budget/execution accounting. This
 * only renders data it's given (the same `SearchRun` `/api/search`
 * returned) — no fetching, no re-running the orchestrator, no scoring or
 * ranking of what's shown. Evidence analysis / problem generation from
 * this evidence is a future stage, not this component's job.
 */
export function SearchResultsPanel({ plan, searchRun }: SearchResultsPanelProps) {
  const { budget_usage: budget, results, executions } = searchRun;
  const failedExecutions = executions.filter((e) => e.status === "error");
  const skippedExecutions = executions.filter(
    (e) => e.status === "skipped_duplicate_query" || e.status === "skipped_budget_exhausted"
  );

  const stats = [
    { label: "Results found", value: results.length },
    { label: "Queries executed", value: `${budget.queries_executed}/${budget.total_query_budget}` },
    { label: "Hypotheses covered", value: plan.hypotheses.length },
    { label: "Search duration", value: formatDuration(searchRun.duration_ms) },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Search className="size-5 text-muted-foreground" />
          Search Evidence
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Real, normalized web-search results from the Search Orchestrator (Stage 3) — traceable back to
          the hypothesis and query that found each one. Not yet scored, ranked, or turned into problems.
        </p>
      </div>

      <div className="flex flex-wrap items-stretch gap-5 rounded-lg border bg-card px-6 py-5 sm:gap-8">
        {stats.map((stat, index) => (
          <div key={stat.label} className="flex items-stretch gap-5 sm:gap-8">
            <div>
              <p className="text-2xl font-semibold tabular-nums">{stat.value}</p>
              <p className="text-sm text-muted-foreground">{stat.label}</p>
            </div>
            {index < stats.length - 1 ? <Separator orientation="vertical" className="h-auto" /> : null}
          </div>
        ))}
      </div>

      {failedExecutions.length > 0 || skippedExecutions.length > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {failedExecutions.length > 0
            ? `${failedExecutions.length} quer${failedExecutions.length === 1 ? "y" : "ies"} failed (rate limits, timeouts, or errors — the run still completed). `
            : null}
          {skippedExecutions.length > 0
            ? `${skippedExecutions.length} quer${skippedExecutions.length === 1 ? "y was" : "ies were"} skipped as duplicate or over-budget, by design.`
            : null}
        </p>
      ) : null}

      <div className="space-y-4">
        {plan.hypotheses.map((hypothesis) => {
          const hypothesisResults = results.filter((r) => r.hypothesis_id === hypothesis.id);
          const hypothesisFailures = failedExecutions.filter((e) => e.hypothesis_id === hypothesis.id);

          return (
            <Card key={hypothesis.id} className="gap-4">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <CardTitle className="text-base leading-snug font-medium text-foreground/90">
                    {hypothesis.hypothesis}
                  </CardTitle>
                  <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                    {hypothesis.lens}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {hypothesisResults.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No sources kept for this hypothesis
                    {hypothesisFailures.length > 0 ? " — every query for it failed (see above)." : " yet."}
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {hypothesisResults.map((result, index) => (
                      <li key={`${result.url}-${index}`}>
                        <a
                          href={result.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-start gap-1.5 text-sm font-medium text-foreground hover:underline"
                        >
                          {result.title}
                          <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                        </a>
                        <p className="mt-0.5 text-sm text-muted-foreground">{result.snippet}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary" className="font-normal">
                            {domainOf(result)}
                          </Badge>
                          {result.published_date ? <span>{result.published_date}</span> : null}
                          <span className="text-muted-foreground/70">via “{result.query}”</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
