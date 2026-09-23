import { Separator } from "@/components/ui/separator";
import type { Problem } from "@/types";

interface ResultsSummaryProps {
  problems: Problem[];
  query?: string;
}

/**
 * Aggregate stats shown above the problem list on the results page.
 * Purely derived from the `problems` it is given — swapping mock data
 * for a real API response requires no changes here.
 */
export function ResultsSummary({ problems, query }: ResultsSummaryProps) {
  const total = problems.length;
  const highRecurrence = problems.filter((p) => p.recurrence === "high").length;
  const totalEvidence = problems.reduce((sum, p) => sum + p.evidenceCount, 0);

  const stats = [
    { label: "Problems found", value: total },
    { label: "High recurrence", value: highRecurrence },
    { label: "Evidence sources", value: totalEvidence },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {query ? `Results for “${query}”` : "Discovered problems"}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground sm:text-base">
          Ranked by how often each problem shows up across independent
          sources.
        </p>
      </div>

      <div className="flex flex-wrap items-stretch gap-5 rounded-lg border bg-card px-6 py-5 sm:gap-8">
        {stats.map((stat, index) => (
          <div key={stat.label} className="flex items-stretch gap-5 sm:gap-8">
            <div>
              <p className="text-3xl font-semibold tabular-nums">
                {stat.value}
              </p>
              <p className="text-sm text-muted-foreground">{stat.label}</p>
            </div>
            {index < stats.length - 1 ? (
              <Separator orientation="vertical" className="h-auto" />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
