import { AlertTriangle, ExternalLink, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  EvidenceAnalysisRun,
  EvidenceRelevance,
  EvidenceStance,
  HypothesisEvidenceAnalysis,
  HypothesisEvidenceStatus,
} from "@/types";

interface EvidenceAnalysisPanelProps {
  analysis: EvidenceAnalysisRun;
}

const STANCE_LABEL: Record<EvidenceStance, string> = {
  supports: "Supports",
  challenges: "Challenges",
  neutral: "Neutral",
};

const STANCE_BADGE_VARIANT: Record<EvidenceStance, "success" | "destructive" | "outline"> = {
  supports: "success",
  challenges: "destructive",
  neutral: "outline",
};

const RELEVANCE_LABEL: Record<EvidenceRelevance, string> = {
  high: "high relevance",
  medium: "medium relevance",
  low: "low relevance",
};

const STATUS_BADGE: Record<HypothesisEvidenceStatus, { label: string; variant: "success" | "destructive" | "outline" }> = {
  analyzed: { label: "Analyzed", variant: "success" },
  no_evidence: { label: "No evidence", variant: "outline" },
  failed: { label: "Analysis failed", variant: "destructive" },
};

function HypothesisEvidenceCard({ result }: { result: HypothesisEvidenceAnalysis }) {
  const status = STATUS_BADGE[result.status];

  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base leading-snug font-medium text-foreground/90">
            {result.hypothesis}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {result.lens}
            </Badge>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {result.status === "failed" ? (
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {result.error ?? "This hypothesis could not be analyzed."}
          </p>
        ) : result.status === "no_evidence" ? (
          <p className="text-sm text-muted-foreground">No retrieved sources were available to analyze for this hypothesis.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {result.support_count} support{result.support_count === 1 ? "" : "s"} · {result.challenge_count} challenge
              {result.challenge_count === 1 ? "" : "s"} · {result.neutral_count} neutral
            </p>
            <ul className="space-y-3">
              {result.evidence.map((entry, index) => (
                <li key={`${entry.url}-${index}`} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={STANCE_BADGE_VARIANT[entry.stance]}>{STANCE_LABEL[entry.stance]}</Badge>
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      {RELEVANCE_LABEL[entry.relevance]}
                    </Badge>
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      {entry.recency}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-sm text-foreground">{entry.evidence_summary}</p>
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                  >
                    {entry.source}
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Renders the Evidence Analyzer's output (Stage 4 — `EvidenceAnalysisRun`)
 * on the results page: each retrieved source classified against the
 * hypothesis it was found for, grouped by hypothesis, exactly as
 * `/api/analyze` returned it. Pure rendering — no re-classifying, scoring,
 * or ranking of what's shown; problem generation from this analysis is a
 * future stage, not this component's job.
 */
export function EvidenceAnalysisPanel({ analysis }: EvidenceAnalysisPanelProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <ShieldCheck className="size-5 text-muted-foreground" />
          Evidence Analysis
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every retrieved source above, classified against the hypothesis it was found for (Stage 4) — not yet
          scored, ranked, or turned into problems.
        </p>
      </div>

      <div className="space-y-4">
        {analysis.hypotheses.map((result) => (
          <HypothesisEvidenceCard key={result.hypothesis_id} result={result} />
        ))}
      </div>
    </div>
  );
}
