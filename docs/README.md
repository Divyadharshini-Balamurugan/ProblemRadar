# ProblemRadar

ProblemRadar helps users explore a question, gather public web evidence, and turn that evidence into candidate problems. The repository contains a Next.js UI and a server-side research pipeline. It has no database, authentication, or durable run storage.

## Current pipeline status

The workspace currently executes five stages sequentially when a user submits a query:

```text
Question
  → 1. Intent and scope (Ollama)
  → 2. Research plan (Ollama)
  → 3. Search (SerpApi)
  → 4. Evidence analysis (Ollama)
  → 5. Candidate problem generation (Ollama)
  → in-memory handoff to /results
```

There is also a sixth capability, Gap Analysis, with its own API route, service, shared types, and client wrapper. It runs focused SerpApi searches for existing solutions and evidence-supported gaps for candidate problems. **It is not yet called by the workspace submission flow**, its output is not saved in `PipelineResult`, and the results page does not render it.

Likewise, stage 5 does run and its `ProblemGenerationResult` is saved and logged, but `/results` currently renders the older illustrative `MOCK_PROBLEMS` cards. It does not yet display generated `CandidateProblem`s. Thus the search and evidence panels are real; the visible problem-card list is still mock data.

## Pages and endpoints

| Route | Role |
| --- | --- |
| `/` | Workspace. Collects the question and runs stages 1–5 in order. |
| `/research` | Cosmetic progress animation shown after the pipeline has completed. |
| `/results` | Shows real search results and evidence analysis when the in-memory handoff exists, then mock problem cards. |
| `POST /api/intent` | Parses the free-text query into `IntentScope`. |
| `POST /api/plan` | Turns `IntentScope` into hypotheses and a search budget. |
| `POST /api/search` | Executes the planned queries and returns `SearchRun`. |
| `POST /api/analyze` | Classifies each retrieved result and returns `EvidenceAnalysisRun`. |
| `POST /api/generate-problems` | Converts evidence analysis into grounded candidate problems. Called by `/`. |
| `POST /api/analyze-gaps` | Searches around candidate problems and analyzes existing solutions/gaps. Available independently; not yet called by `/`. |

## Stage details

### 1. Intent and scope

`app/api/intent/route.ts` validates `{ query }`, then calls `extractIntentScope()` in `lib/llm/intent-agent.ts`. The model returns an `IntentScope` containing `intent`, `domain`, `audience`, nullable `location` and `specific_problem`, `breadth`, `time_scope`, and `research_targets`. The response is parsed and schema-checked; malformed model output gets at most one retry. This stage does not search the web.

### 2. Research planning

`app/api/plan/route.ts` validates the incoming intent and calls `generateResearchPlan()` in `lib/llm/research-planner.ts`. The model proposes 3–7 hypotheses, each with a controlled lens, evidence targets, source strategies, and search queries. Code validates the plan and checks quality constraints such as distinct hypotheses and grounded, non-stale queries. The search budget is computed deterministically from breadth and hypothesis count: narrow gets 3 queries per hypothesis, broad gets 5, and other breadth values get 4; each hypothesis has a source cap of 5.

### 3. Search

`app/api/search/route.ts` validates the public `ResearchPlan` shape and calls `runSearchOrchestrator()` in `lib/search/search-orchestrator.ts`. The orchestrator executes searches sequentially, applies per-hypothesis and total budgets, skips exact or near-duplicate queries, canonicalizes URLs to deduplicate sources across the run, and records each query as successful, failed, or skipped. A single query failure does not abort the run. `lib/search/serpapi-client.ts` is the only module that knows SerpApi's response format; it normalizes organic results. This stage does not use an LLM.

### 4. Evidence analysis

`app/api/analyze/route.ts` accepts the plan and its `SearchRun`; it does not search again. `runEvidenceAnalyzer()` groups results by hypothesis and asks the LLM to classify each source as supporting, challenging, or neutral, assign relevance, and summarize only what the source title/snippet supports. Code checks that every input source has exactly one output and that summaries are grounded in source text. Recency is calculated from the search result's publication date in code. Errors are isolated per hypothesis and represented with a `failed` status.

### 5. Candidate problem generation

`app/api/generate-problems/route.ts` accepts a plan and `EvidenceAnalysisRun`. `runProblemGenerator()` ignores neutral and low-relevance items for candidate support, weighs medium/high relevance, considers relevant challenges, and avoids calling the model when evidence is absent or insufficient. For each eligible hypothesis, the model may return up to three candidates. The service validates the candidate fields and evidence indices, checks claims against cited evidence (including unsupported statistics, populations, stronger quantifiers, and negation/failure claims), maps indices to original evidence references, and merges duplicate candidates while retaining references. Hypotheses run in a bounded-concurrency pool and failures stay local to their hypothesis.

`CandidateProblem` includes a statement, affected population and activity, context, mechanism, observed impact, supporting evidence references, and evidence strength. Optional `observations` can hold atomic claims and the numbered evidence indices backing each claim. See `types/problem-generation.ts`.

### 6. Gap Analysis capability (not wired into workspace yet)

`POST /api/analyze-gaps` accepts a list of candidate problems. `runGapAnalysis()` builds up to five problem-specific search queries per candidate and searches SerpApi for existing solutions, programs, services, and interventions. It keeps at most eight unique sources per candidate, then asks the LLM to identify evidence-backed existing solutions, addressed aspects, and unresolved gaps. Code resolves citations back to real search results, checks groundedness and statistics, deduplicates solutions/gaps, and rejects claims that no solution exists. Candidate analyses run with bounded concurrency and individual failures are captured. The result shape is `GapAnalysisResult` in `types/gap-analysis.ts`.

The endpoint is independently callable, and `requestGapAnalysis()` exists in `lib/api-client.ts`; however, `app/page.tsx` currently stops after stage 5. `PipelineResult` has no gap-analysis field and `/results` has no gap-analysis panel.

## Technical wiring

`app/page.tsx` calls the wrappers in `lib/api-client.ts`. Each wrapper sends JSON to one route and turns an unsuccessful HTTP/API response into a client error. The route handler validates its own request body with Zod and calls a service under `lib/llm/` or `lib/search/`. Shared request/response shapes live under `types/` and are re-exported by `types/index.ts`.

The LLM services depend on the `LLMProvider` interface (`lib/llm/provider.ts`), not directly on a vendor API. `getLLMProvider()` currently constructs a cached `OllamaProvider`; configuration defaults to `http://localhost:11434`, model `qwen3:8b`, and a 240-second timeout. `format: "json"` constrains syntax, while the individual agents still parse and validate the expected shape. `withRetry()` bounds retries for invalid model output; provider connection failures are handled separately.

After stage 5 succeeds, `app/page.tsx` saves `{ query, intent, plan, searchRun, analysis, problemGeneration }` through `setPipelineResult()`, then navigates to `/research?q=...`. The results page reads the module-level client store once. The URL carries the query string for display; the structured pipeline result is not in the URL or a server database. A full reload clears the store, so direct/reloaded `/results` displays mock problems only.

## Source tree

```text
app/                       App Router pages, root layout, styles, and route handlers
  api/intent/               Stage 1 endpoint
  api/plan/                 Stage 2 endpoint
  api/search/               Stage 3 endpoint
  api/analyze/              Stage 4 endpoint
  api/generate-problems/    Stage 5 endpoint
  api/analyze-gaps/         Stage 6 capability endpoint (not in main flow)
  research/                 Cosmetic progress route
  results/                  Search/evidence panels and mock problem cards
components/                Product components and generic UI primitives
docs/                      Project, development, and UI-flow documentation
lib/api-client.ts           Browser-to-route wrappers
lib/pipeline-store.ts       Temporary client-side pipeline handoff
lib/llm/                    Provider, agents, parsing, retries, generation, gap analysis
lib/search/                 SerpApi client and search orchestration
lib/mock-data.ts            Quick Start text, progress stages, illustrative problems
types/                      Shared pipeline and UI data shapes
tests/                      Unit tests for candidate generation and gap analysis
public/                     Static assets
```

## UI components

- `ProblemRadarHeader`: shared site header.
- `ExplorationInput` and `QuickStartOptions`: query entry and guided prefill.
- `ResearchProgress`: renders supplied progress stages; it does not own the timer.
- `SearchResultsPanel`: renders the real `ResearchPlan` and `SearchRun`.
- `EvidenceAnalysisPanel`: renders real per-hypothesis evidence analysis.
- `ProblemCard` and `ResultsSummary`: currently render/aggregate mock `Problem` objects, not `CandidateProblem`s.
- `components/ui/*`: generic button, badge, card, progress, separator, skeleton, tabs, textarea, and tooltip primitives.

## Current limitations

- No database, authentication, saved runs, or durable state.
- The progress page is timed demo UI and begins after the real work finishes.
- Candidate problem generation runs, but generated candidates are not shown on `/results`.
- Gap analysis exists as a separate endpoint but is not called by the workspace flow or displayed.
- Search returns SerpApi organic-result titles/snippets; the analyzer and downstream stages interpret those snippets rather than fetching full page content.
- The visible `MOCK_PROBLEMS` list and its recurrence/count statistics are illustrative and are not derived from the current query.
