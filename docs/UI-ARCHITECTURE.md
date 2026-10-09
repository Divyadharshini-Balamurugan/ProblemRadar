# UI and Pipeline Architecture

This document describes the current page flow and how UI state connects to the server pipeline. The workspace runs five stages before showing the progress screen. Gap Analysis is implemented as a standalone capability but is not part of this page flow yet.

## Main page flow

```text
Browser: / (app/page.tsx)
  ├─ POST /api/intent              → IntentScope
  ├─ POST /api/plan                → ResearchPlan
  ├─ POST /api/search              → SearchRun
  ├─ POST /api/analyze             → EvidenceAnalysisRun
  ├─ POST /api/generate-problems   → ProblemGenerationResult
  │
  ├─ setPipelineResult({...})      → browser module memory
  └─ navigate to /research?q=...
       └─ timed progress UI
            └─ /results?q=...
                 ├─ SearchResultsPanel (real search output)
                 ├─ EvidenceAnalysisPanel (real analysis output)
                 └─ ResultsSummary + ProblemCard (MOCK_PROBLEMS)
```

The workspace calls stages sequentially through `lib/api-client.ts`. It sends only each stage's required input: query; then query plus intent; then plan; then plan plus search run; then plan plus evidence analysis. Each API route validates its own JSON request with Zod before calling the corresponding `lib/` service.

If one of the five workspace calls returns an HTTP/API error, the workspace shows the error beneath the input and stays on `/`. The earlier completed stage outputs are not persisted for a resume; a retry starts the query from stage 1. Internal per-item failures are different: the search stage records failures per query, the Evidence Analyzer records failures per hypothesis, and the Problem Generator records failures per hypothesis. Those can still produce an overall successful response.

## What is stored and when

After all five stages return, `app/page.tsx` calls `setPipelineResult()` with:

```ts
{
  query,
  intent,
  plan,
  searchRun,
  analysis,
  problemGeneration,
}
```

`lib/pipeline-store.ts` holds this value in a module-level variable in the browser's JavaScript runtime. Next.js client navigation keeps that module available between the workspace and results page in the same tab. It is not a database, server session, URL payload, or cross-tab store. Reloading the page resets it.

The original query is encoded in the URL for `/research` and `/results`, where it is used for display. The structured outputs are read from `getPipelineResult()` once when `/results` initializes. If the store is empty—such as after reload or direct navigation—the current page falls back to `MOCK_PROBLEMS` and does not re-run the pipeline.

## Progress page timing

`app/research/page.tsx` begins only after the real pipeline has returned and the result is stored. It advances through the six display stages in `lib/mock-data.ts`, roughly every 900 ms. These six labels are presentation copy, not live statuses from the five server stages or Gap Analysis. `components/research-progress.tsx` only renders the stage array and progress bar it receives; the page owns the timer.

## Results page responsibilities

`app/results/page.tsx` reads the current query parameter and pipeline store. If a pipeline result exists:

1. `SearchResultsPanel` receives the real `ResearchPlan` and `SearchRun` and groups results by hypothesis, displaying search/budget stats and failed/skipped query counts.
2. `EvidenceAnalysisPanel` receives the real `EvidenceAnalysisRun` and displays status, stance, relevance, recency, summaries, and source links per hypothesis.
3. The page then renders the illustrative `MOCK_PROBLEMS` data using `ResultsSummary` and `ProblemCard`.

Although `problemGeneration` is included in the stored result, the current page only logs it to the browser console; it does not render `CandidateProblem`s. Gap-analysis results are not in `PipelineResult` and are not rendered either. `ProblemCard` expects the older `Problem` model (`title`, `description`, recurrence counts and tags), while generated candidates use the distinct `CandidateProblem` model with evidence-grounded fields and references.

## Component responsibilities

### Workspace

- `app/page.tsx`: owns query text, Quick Start context, stage messages, submission guard, errors, and pipeline call order.
- `components/exploration-input.tsx`: controlled textarea and submit affordance; Ctrl/Cmd+Enter delegates to the page.
- `components/quick-start-options.tsx`: renders static guided options/chips and calls the page callbacks. It does not submit or call APIs.

### Progress and results

- `app/research/page.tsx`: reads the query and owns the demo timer plus the continue button.
- `components/research-progress.tsx`: presentational stage list/progress bar.
- `app/results/page.tsx`: reads the query and stored outputs, chooses whether real evidence panels can render, then supplies mock problems to the existing card UI.
- `components/search-results-panel.tsx`: presentational renderer for `ResearchPlan` + `SearchRun`.
- `components/evidence-analysis-panel.tsx`: presentational renderer for `EvidenceAnalysisRun`.
- `components/problem-card.tsx`: interactive evidence toggle for the mock `Problem` type.
- `components/results-summary.tsx`: derives summary counts from the `Problem[]` provided; currently those are mock values.
- `components/problem-radar-header.tsx`: static site header rendered from the root layout.
- `components/ui/*`: generic Radix/shadcn-style primitives without ProblemRadar pipeline responsibilities.

## Stage 6: Gap Analysis is separate today

`lib/api-client.ts` exports `requestGapAnalysis(problems)`, which calls `POST /api/analyze-gaps`. That route validates `CandidateProblem[]` and invokes `runGapAnalysis()` in `lib/llm/gap-analyzer.ts`. The service performs focused SerpApi searches and uses the LLM to synthesize evidence-backed solutions and unresolved gaps. It returns a `GapAnalysisResult` with source references and per-candidate status.

No current page calls `requestGapAnalysis()`. The workspace stops after candidate problem generation, and the pipeline store and results page do not yet include this output. To wire the stage into the product flow, the next implementation would need to call it with the generated candidate list, add its result to the handoff type, and create a results renderer.

## Data boundaries

```text
types/  ── shared shapes ──▶ API routes ──▶ lib services
  ▲                              ▲               │
  │                              │               ├─ LLMProvider → Ollama
  │                              │               └─ search client → SerpApi
  │                              │
components/pages ◀── api-client.ts ◀── browser fetch responses
       │
       └─ pipeline-store.ts transports stage 1–5 outputs across client navigation
```

`types/` describes contracts but does not implement validation. Routes and agent/service code use Zod schemas at runtime. The LLM provider abstraction is in `lib/llm/provider.ts`; Ollama-specific HTTP handling stays in `lib/llm/providers/ollama-provider.ts`. SerpApi response handling stays in `lib/search/serpapi-client.ts`. This keeps UI components independent of vendor request formats.
