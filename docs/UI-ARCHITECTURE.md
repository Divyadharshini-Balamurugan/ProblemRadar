# UI Architecture

This document explains how the three pages fit together, what each
component is responsible for, and how data flows between them today.
The workspace → `/api/intent` → `/api/plan` → `/api/search` →
`/api/analyze` chain is real and now runs automatically, end-to-end,
from one submit on `/`; only `/results`'s `ProblemCard` list past the
Search Evidence and Evidence Analysis panels is still mock, client-side
data.

## Page flow

```
 /                       /api/intent (real)      /api/plan (real)        /api/search (real)       /api/analyze (real)      /research?q=...           /results?q=...
 ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌────────────────────┐    ┌────────────────────┐    ┌───────────────────────┐
 │ Workspace          │──▶│ Intent/Scope Agent │──▶│ Research Planner   │──▶│ Search Orchestrator │──▶│ Evidence Analyzer   │──▶│ Research progress    │──▶│ Results                 │
 │ (page.tsx)          │    │ (Ollama + Qwen3)    │    │ (Ollama + Qwen3)    │    │ (SerpApi, no LLM)    │    │ (Ollama + Qwen3)     │    │ (research/page.tsx)  │    │ (results/page.tsx)      │
 └──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘    └────────────────────┘    └────────────────────┘    └───────────────────────┘
                                                                                      │                          │                                                     ▲
                                                                                      └──────────────────────────┴─────────── lib/pipeline-store.ts ───────────────────┘
                                                                                                                     (in-memory handoff, not the URL)
```

1. The user types a query (optionally guided by a Quick Start option or
   chip) on `/` and submits it.
2. `page.tsx`'s single `handleSubmit()` calls `requestIntentScope(query)`
   (`lib/api-client.ts`), which `POST`s to `/api/intent`. That route runs
   the Intent/Scope Agent against the local LLM, validates its JSON, logs
   both the input and the parsed result to the server console, and
   returns the parsed `IntentScope`.
3. On success, `handleSubmit` immediately calls
   `requestResearchPlan(query, intent)`, which `POST`s that validated
   `IntentScope` to `/api/plan`. That route runs the Research Planner
   against the local LLM, validates its JSON (both structurally and
   against the deterministic duplicate/near-duplicate checks described in
   `docs/README.md`), logs the input and result to the server console,
   and returns the validated `ResearchPlan`.
4. On success, `handleSubmit` immediately calls `requestSearchRun(plan)`,
   which `POST`s that exact `ResearchPlan` to `/api/search` — no new plan
   is generated and no LLM is called here. That route runs the Search
   Orchestrator against real SerpApi queries, budget-bounded and
   deduplicated as described in `docs/README.md`, and returns the
   resulting `SearchRun`.
5. On success, `handleSubmit` immediately calls
   `requestEvidenceAnalysis(plan, searchRun)`, which `POST`s that exact
   `ResearchPlan` and `SearchRun` to `/api/analyze` — no new plan or
   search is run here, only evidence interpretation over the results
   already retrieved. That route runs the Evidence Analyzer against the
   local LLM hypothesis-by-hypothesis, validates its structured output
   (including the groundedness and recency checks described in
   `docs/README.md`), and returns the resulting `EvidenceAnalysisRun`,
   with individual hypothesis failures isolated rather than thrown (see
   the note on this below).
6. On success, `handleSubmit` calls `setPipelineResult({ query, intent,
   plan, searchRun, analysis })` (`lib/pipeline-store.ts` — an in-memory
   module singleton, not the URL or a database) and only then
   `router.push`es to `/research?q=<query>`. The query itself still
   travels through the URL (so `/research` and `/results` stay
   independently loadable/shareable by query text), but the actual
   pipeline data travels through the store, since it's too large and
   structured for a URL param.
7. On failure at any of the four stages (Ollama not running, bad model
   output, validation failure, SerpApi misconfigured, etc.), the page
   shows the error message returned by that stage's API under the input
   and never navigates — the user can fix their local setup and resubmit.
   A failure partway through means the earlier stage(s) already
   succeeded; the user only resubmits the whole query, since the pipeline
   isn't resumable mid-stage yet. In practice, the Evidence Analyzer
   almost never reaches this page-level error path — see below.
8. `/research` simulates a multi-stage research run and, once "complete,"
   lets the user continue to `/results?q=<query>`. It doesn't read the
   pipeline store itself — it's purely a cosmetic timer.
9. `/results` reads `q` back out of the URL (for display only) and calls
   `getPipelineResult()` once, via lazy `useState` initialization. If a
   result is there (the normal case, following the flow above), it
   renders `SearchResultsPanel` with the real `plan`/`searchRun`, followed
   by `EvidenceAnalysisPanel` with the real `analysis`, above the mock
   `Problem[]` list; if not (e.g. the user reloaded `/results` directly,
   which clears the in-memory store), it silently falls back to rendering
   only the mock list, exactly as before this wiring existed.

**Per-hypothesis failure is not a page-level error.** The Evidence
Analyzer (unmodified — see `docs/README.md`) isolates failures per
hypothesis: if the local LLM is completely unreachable, `/api/analyze`
still returns HTTP 200 / `ok: true`, with every hypothesis's `status`
set to `"failed"` and an `error` message attached. This means the red
page-level error banner in step 7 essentially never fires for this
stage under realistic conditions — instead, `EvidenceAnalysisPanel`
renders each failed hypothesis in place with an "Analysis failed" badge
and its error text, which is the intended graceful-degradation behavior
of the analyzer, not a gap in this wiring.

Passing the query via the URL (rather than a store or context) keeps
each route independently loadable and keeps the door open for `/results`
and `/research` to become server-rendered against a real API later
without a state-management rewrite. The pipeline result itself uses the
module-singleton store described above precisely because it doesn't fit
that constraint — it doesn't survive a reload, and that's an accepted
tradeoff until there's a real backend to fetch it from instead.

## Component responsibilities

### `components/problem-radar-header.tsx`

Static site-wide top bar (logo + wordmark). Rendered once, in
`app/layout.tsx`, so every route gets it automatically. No state, no
props.

### `components/exploration-input.tsx` (client)

Owns the presentation of the natural-language input: the `Textarea`,
the "Discover Problems" submit `Button`, the ⌘/Ctrl+Enter shortcut, and
an optional dismissible badge showing which Quick Start option or chip
is currently guiding the input. It is fully controlled — the parent page
owns `value` and passes `onChange` / `onSubmit` — so it has no opinion
about what happens after submit, including the `isSubmitting` loading
state that now spans all four of the `/api/intent`, `/api/plan`,
`/api/search`, and `/api/analyze` calls.

### `components/quick-start-options.tsx` (client)

Renders the three Quick Start `Card`s (Discover Problems / Explore an
Area / Investigate a Problem) and the People/Industry/Location chip row.
It reads its option and chip data directly from `lib/mock-data.ts`
(since that data is static configuration, not something a page needs to
vary), but calls back up to the parent (`onSelectOption` /
`onSelectChip`) so the page decides what selecting one actually does to
the input value and URL.

### `components/research-progress.tsx`

Purely presentational: given a `ResearchStage[]` (and optionally the
original query string), it renders a progress bar and a vertical stage
list with status icons (complete / active / pending). It has no timers
or side effects of its own — `app/research/page.tsx` owns the mock
timer and passes updated stage arrays down as props. This means swapping
the mock timer for a real streaming/polling source later only touches
the page, not this component.

### `components/problem-card.tsx` (client)

Renders one `Problem`: title, recurrence badge, description, tags,
evidence/recurrence counts, and an expandable "View Evidence" list of
sources. The only local state is whether the evidence list is expanded.

### `components/results-summary.tsx`

Purely presentational aggregate stats (problems found, high-recurrence
count, total evidence sources) computed from whatever `Problem[]` it is
given.

### `components/search-results-panel.tsx`

Purely presentational, like `results-summary.tsx`: given the real `plan`
(`ResearchPlan`) and `searchRun` (`SearchRun`) from the pipeline store, it
groups `searchRun.results` by `hypothesis_id`, renders budget/execution
stats, and flags failed or skipped queries. No fetching, no re-running
the orchestrator, and no scoring/ranking of what it's given.

### `components/evidence-analysis-panel.tsx`

Purely presentational, like `search-results-panel.tsx`: given the real
`analysis` (`EvidenceAnalysisRun`) from the pipeline store, it renders one
card per hypothesis with a status badge (`Analyzed` / `No evidence` /
`Analysis failed`) and, for analyzed hypotheses, one entry per piece of
evidence with its stance (`Supports` / `Challenges` / `Neutral`, reusing
the existing `Badge` variants), relevance, recency, summary, and a link
back to the original source. No fetching, no scoring/ranking — that's a
future stage's job, not this component's.

### `components/ui/*`

shadcn/ui-style primitives only (Button, Card, Textarea, Badge,
Separator, Progress, Tabs, Skeleton, Tooltip). These have no
ProblemRadar-specific logic and should stay that way — anything
domain-specific belongs in `components/`, not `components/ui/`.

## State ownership

There is no global store or state-management library. Each page owns the
state relevant to it:

- `app/page.tsx` — the input text, which Quick Start option/chip is
  active, whether the `/api/intent` → `/api/plan` → `/api/search` →
  `/api/analyze` chain is in flight (`isSubmitting`), the current stage's
  status message, and any error message from any of the four calls.
- `app/research/page.tsx` — the mock stage array and whether the mock
  run has finished.
- `app/results/page.tsx` — the pipeline result read once from
  `lib/pipeline-store.ts` (a plain module-level singleton, not a
  React context or a store library — see "Page flow" above); `Tabs`
  manages its own selected-filter state internally (uncontrolled).

## Data flow

```
types/  ──defines shapes──▶  lib/mock-data.ts  ──imported by──▶  components / pages
   │
   └──defines shapes──▶  lib/llm/ (intent-agent.ts)        ──called by──▶  app/api/intent/route.ts  ──┐
   └──defines shapes──▶  lib/llm/ (research-planner.ts)    ──called by──▶  app/api/plan/route.ts    ──┤
   └──defines shapes──▶  lib/search/ (search-orchestrator.ts) ──called by──▶  app/api/search/route.ts ──┤
   └──defines shapes──▶  lib/llm/ (evidence-analyzer.ts)   ──called by──▶  app/api/analyze/route.ts  ──┴──fetched by──▶  lib/api-client.ts  ──called by──▶  app/page.tsx
                                                                                                                                                                    │
                                                                                                                                    setPipelineResult() ◀───────────┘
                                                                                                                                            │
                                                                                                                              lib/pipeline-store.ts
                                                                                                                                            │
                                                                                                              getPipelineResult() ──read by──▶  app/results/page.tsx  ──renders──▶  SearchResultsPanel, EvidenceAnalysisPanel
```

All three agents share `lib/llm/json-utils.ts` for parsing raw model
text and `lib/llm/index.ts`'s `getLLMProvider()` for talking to the
model, so adding the Research Planner and the Evidence Analyzer each
required no changes to the provider layer itself. The Search
Orchestrator is deterministic code, not an agent, so it has no provider
dependency at all — see `lib/search/config.ts` and `serpapi-client.ts`.

`types/` has no dependencies on React, mock data, or the LLM layer — it
only describes shapes (`Problem`, `ResearchStage`, `QuickStartOption`,
`IntentScope`, `ResearchPlan`, etc.). This is what makes it safe to later replace
`lib/mock-data.ts` with a real data source, or `lib/llm/`'s Ollama
provider with a different one, without changing any component: as long
as the new source returns the same shapes, the UI is unaffected. See
`docs/DEVELOPMENT.md` for how the `LLMProvider` abstraction is meant to
be extended.
