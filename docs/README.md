# ProblemRadar

ProblemRadar is a research product that helps builders, founders, and
product teams discover **real, evidence-backed problems** worth solving —
before they write a single line of application code. Instead of guessing
what to build, a user describes what they're curious about (a person, an
industry, a location, or a problem they already suspect exists), and
ProblemRadar is meant to search real sources, cluster recurring
complaints, and surface validated problem opportunities with the
evidence behind them.

This repository contains the MVP user interface, plus four stages of the
real research pipeline, now wired together end-to-end: the **Intent/Scope
Agent**, which turns a user's free-text question into structured JSON;
the **Research Planner**, which turns that structured scope into a small
set of diverse research hypotheses; the **Search Orchestrator**, which
turns those hypotheses' candidate queries into real, budget-bounded
SerpApi searches and normalized results (no LLM involved); and the
**Evidence Analyzer**, which classifies each retrieved source against the
hypothesis it was found for (supports / challenges / neutral), using a
local LLM only to interpret already-retrieved text, never to search.
Submitting a query on the workspace now runs all four stages in sequence
and shows the real search evidence and its analysis on `/results`.
Problem detection from that analysis is still mock data. See "Research
pipeline: current status" below.

## Current UI scope

What exists today is a fully working, responsive UI shell for the three
core moments of the ProblemRadar experience:

1. **Workspace (`/`)** — the entry point. A natural-language input
   ("What do you want to discover?") plus a Quick Start section with
   three guided modes (Discover Problems, Explore an Area, Investigate a
   Problem) and three quick exploration chips (People, Industry,
   Location). Selecting a Quick Start option or chip only prefills and
   labels the input — it never restricts free typing.
2. **Research state (`/research`)** — a reusable progress UI that walks
   through the stages a real research run will eventually go through:
   Understanding your request → Generating research directions →
   Searching sources → Analyzing recurring problems → Validating
   findings → Building opportunities. The stage progression on this page
   is simulated with a timer for demo purposes only.
3. **Results (`/results`)** — now shows a real **Search Evidence** panel
   (the normalized `SearchResult`s from the just-completed search run,
   grouped by hypothesis, with budget/execution stats — see
   `components/search-results-panel.tsx`), then a real **Evidence
   Analysis** panel (each of those sources classified against its
   hypothesis — supports / challenges / neutral, with relevance, recency,
   and a grounded evidence summary — see
   `components/evidence-analysis-panel.tsx`), followed by the original
   placeholder results section: reusable `ProblemCard` components (title,
   description, recurrence badge, evidence count, "View Evidence" toggle)
   from mock data, with tabs to filter by recurrence level. Turning the
   evidence analysis into real `Problem`s (scoring, ranking, generation)
   is a future stage, not this one.

Submitting the workspace input now runs all four real backend stages in
sequence — `POST /api/intent` (Intent/Scope Agent), then `POST /api/plan`
(Research Planner), then `POST /api/search` (Search Orchestrator), then
`POST /api/analyze` (Evidence Analyzer) — before navigating anywhere; see
"Application wiring" and "Research pipeline: current status" below. The
`/research` stage list is still a cosmetic timer (real work already
finished by the time it's shown), and the `ProblemCard` list on
`/results` is still mock data: there is no database, no authentication,
and no problem-detection, scoring, or ranking logic yet.

## Technology stack

- **Next.js** (App Router) + **TypeScript**
- **Tailwind CSS v4** for styling, using CSS variables for theming
  (see `app/globals.css`)
- **shadcn/ui**-style components (Radix UI primitives + `class-variance-authority`,
  hand-authored under `components/ui/` to match the standard shadcn/ui
  API) — Button, Card, Textarea, Badge, Separator, Progress, Tabs,
  Skeleton, Tooltip
- **lucide-react** for icons
- **Ollama** running **Qwen3 8B** locally, for the Intent/Scope Agent and
  the Research Planner (see below) — swappable via `lib/llm/`
- **SerpApi** for the Search Orchestrator's real web searches (see
  below) — no LLM involved in this stage
- **Zod** for validating API request bodies and the LLM's JSON output
- No other component library, CSS framework, state manager, or
  persistent data layer is used

## Folder structure

```
app/                     Routes and layouts (App Router)
  layout.tsx              Root layout: fonts, metadata, shared header
  page.tsx                 Workspace ("What do you want to discover?")
  research/page.tsx        Research progress state
  results/page.tsx         Placeholder results page
  api/intent/route.ts      POST endpoint: runs the Intent/Scope Agent
  api/plan/route.ts         POST endpoint: runs the Research Planner
  api/search/route.ts        POST endpoint: runs the Search Orchestrator
  api/analyze/route.ts        POST endpoint: runs the Evidence Analyzer
components/               ProblemRadar-specific reusable components
  problem-radar-header.tsx
  exploration-input.tsx
  quick-start-options.tsx
  research-progress.tsx
  problem-card.tsx
  results-summary.tsx
  search-results-panel.tsx  Renders a completed SearchRun (stage 3) on /results
  evidence-analysis-panel.tsx Renders a completed EvidenceAnalysisRun (stage 4) on /results
  ui/                      shadcn/ui primitives only (Button, Card, ...)
lib/                       Utilities and service helpers
  utils.ts                 cn() class-merging helper
  mock-data.ts              Mock data still used by /research and /results
  api-client.ts             Client-side fetch wrappers for /api/intent, /api/plan, /api/search, /api/analyze
  pipeline-store.ts          In-memory handoff of the completed pipeline result to /results
  llm/                       LLM provider abstraction + agents
    config.ts                 Provider/model selection (env-driven)
    provider.ts                LLMProvider interface every provider implements
    providers/ollama-provider.ts  Ollama implementation of LLMProvider
    index.ts                    getLLMProvider() factory
    json-utils.ts                Shared raw-LLM-text parsing helpers
    with-retry.ts                 Shared bounded-retry helper for invalid LLM JSON
    intent-agent.ts              Stage 1: extractIntentScope(query)
    research-planner.ts           Stage 2: generateResearchPlan(intent)
    evidence-analyzer.ts           Stage 4: runEvidenceAnalyzer(plan, run)
  search/                     Stage 3: SerpApi search layer (no LLM)
    config.ts                    SerpApi key/timeout/result-count (env-driven)
    serpapi-client.ts             Talks to SerpApi's /search.json; SerpApiError
    search-orchestrator.ts        Stage 3: runSearchOrchestrator(plan)
types/                     Shared TypeScript types
  exploration.ts, research.ts, problem.ts, intent.ts, research-plan.ts,
  search.ts, evidence.ts, index.ts
scripts/
  check-ollama.mjs          Local dev helper: confirms Ollama is running
                            and pulls the configured model if missing
public/                    Static assets
docs/                       This documentation
```

## Available pages

| Route            | Purpose                                                     |
| ---------------- | ------------------------------------------------------------ |
| `/`              | Main ProblemRadar workspace and entry point                   |
| `/research`      | Cosmetic research-in-progress state (stage list + bar)          |
| `/results`       | Real Search Evidence panel, plus a mock `ProblemCard` list, filterable |
| `POST /api/intent` | Runs the Intent/Scope Agent against the submitted query        |
| `POST /api/plan`   | Runs the Research Planner against a validated Intent/Scope object |
| `POST /api/search` | Runs the Search Orchestrator against a validated ResearchPlan   |
| `POST /api/analyze` | Runs the Evidence Analyzer against a validated ResearchPlan + SearchRun |

## Reusable components

- **`ProblemRadarHeader`** — site-wide top bar (logo + wordmark).
- **`ExplorationInput`** — the large natural-language textarea, submit
  button, keyboard shortcut, and optional "guided context" badge.
- **`QuickStartOptions`** — the three Quick Start option cards plus the
  People/Industry/Location chips.
- **`ResearchProgress`** — renders a list of `ResearchStage` objects with
  a progress bar; accepts any stage array, so it works the same with
  real, streamed stage updates later.
- **`ProblemCard`** — a single discovered problem: title, description,
  recurrence badge, tags, evidence count, and an expandable "View
  Evidence" source list.
- **`ResultsSummary`** — aggregate stats shown above the results list
  (problems found, high-recurrence count, total evidence sources).
- **`SearchResultsPanel`** — renders a completed `SearchRun` (stage 3's
  output): normalized results grouped by hypothesis, with budget/
  execution stats. Pure rendering — no fetching, scoring, or ranking.
- **`EvidenceAnalysisPanel`** — renders a completed `EvidenceAnalysisRun`
  (stage 4's output): each source's stance/relevance/recency/summary,
  grouped by hypothesis, plus each hypothesis's own status (analyzed / no
  evidence / failed). Pure rendering — no re-classifying, scoring, or
  ranking.

## Current mock-data approach

Quick Start options, chips, research stages, and the six sample problems
shown on `/results` all still live in `lib/mock-data.ts`, typed against
the shapes in `types/`. Components simply import and render this data
(or receive it as props) — the Intent/Scope Agent and Research Planner
above are the two pieces of the pipeline that are no longer mocked. This
keeps the rest of the UI fully functional and demoable while making the
eventual swap to real data a matter of replacing the data source, not
the components.

## Research pipeline: current status

```
User question
  → Intent/Scope Agent     ✅ IMPLEMENTED — POST /api/intent, local LLM (Ollama + Qwen3)
  → Research planner        ✅ IMPLEMENTED — POST /api/plan, local LLM (Ollama + Qwen3)
  → Search Orchestrator     ✅ IMPLEMENTED — POST /api/search, real SerpApi, no LLM
  → Evidence Analyzer        ✅ IMPLEMENTED — POST /api/analyze, local LLM (Ollama + Qwen3), wired into the UI
  → Problem detection        ⏳ not built yet
  → Results UI                ✅ real Search Evidence + Evidence Analysis panels + still-mock `MOCK_PROBLEMS` below them
```

### Intent/Scope Agent (stage 1)

When the user submits the workspace input, the client calls
`POST /api/intent` with `{ query: string }`. That route (`app/api/intent/route.ts`):

1. Validates the request body with Zod.
2. Prints the raw user input to the server console.
3. Calls `extractIntentScope(query)` (`lib/llm/intent-agent.ts`), which
   prompts the configured LLM to return **only** a JSON object with these
   keys: `intent`, `domain`, `audience`, `location`, `specific_problem`,
   `breadth`, `time_scope`, `research_targets`.
4. Validates that JSON against a Zod schema (`IntentScopeSchema`) — if
   the model's output doesn't parse as JSON, or is missing/mistypes a
   field, the attempt is treated as failed instead of silently passing bad
   data downstream. Also defensively coerces the literal text `"null"` /
   `"JSON null"` back to a real `null` for the two nullable fields, since
   models sometimes echo a prompt instruction like "otherwise JSON null"
   back as a string instead of following it.
5. If the attempt failed, retries once more (`lib/llm/with-retry.ts`, up
   to `MAX_ATTEMPTS = 2` total) before giving up — `format: "json"` only
   guarantees syntactically valid JSON, not the right shape, so an
   occasional malformed response is expected and asking again is usually
   enough. A retry (and the raw output that triggered it) is logged to the
   server console; a connection failure is never retried this way.
6. Prints the validated JSON to the server console.
7. Returns `{ ok: true, intent }` to the client (or `{ ok: false, error }`
   if every attempt failed).

No web search happens here, and the result isn't yet fed into
`/research` or `/results` — the client just logs it to the browser
console and continues to `/research` as before. Wiring the Intent/Scope
output into a real Research Planner is the next stage, not this one.

**Provider is swappable.** Nothing outside `lib/llm/` knows it's talking
to Ollama specifically — `intent-agent.ts` only calls the generic
`LLMProvider` interface (`lib/llm/provider.ts`). Adding a second provider
(a hosted API, a different local runtime) means writing one new class in
`lib/llm/providers/` and adding one `case` to `getLLMProvider()` in
`lib/llm/index.ts`; no agent or route code changes. Provider/model choice
is entirely env-driven (`lib/llm/config.ts`, see `.env.example`).

**Local setup required.** This stage needs Ollama running on your own
machine with the `qwen3:8b` model pulled. See `docs/DEVELOPMENT.md` for
setup, or run `npm run check:ollama`.

### Research Planner (stage 2)

Once `/api/intent` returns a validated `IntentScope`, the client
immediately calls `POST /api/plan` with `{ query, intent }` (the query is
carried along only so the server log is self-explanatory — the planner's
actual input is `intent`, not the raw text). That route
(`app/api/plan/route.ts`):

1. Validates the request body with Zod (`intent` must already match
   `IntentScopeSchema`).
2. Prints the incoming Intent/Scope JSON to the server console.
3. Calls `generateResearchPlan(intent)` (`lib/llm/research-planner.ts`),
   which prompts the configured LLM with the scope plus a controlled
   13-item "lens" vocabulary (time, cost, manual_work, availability,
   access, coordination, information, reliability, trust, compliance,
   workflow, existing_solution_failure, workaround) and asks it to return
   **only** a JSON object listing 3–7 `hypotheses`, each with `id`, `lens`,
   `hypothesis`, `evidence_targets`, `source_strategies`, and
   `search_queries`. The prompt is deliberately terse (short lens
   definitions, compact intent JSON, "Output ONLY the JSON object" stated
   up front and repeated at the end) — on CPU-only local inference, output
   length dominates latency far more than prompt length, so `evidence_targets`,
   `source_strategies`, and `search_queries` are each capped at 2-3 items
   (down from an earlier 2-5) and `hypothesis` itself is capped at 220
   characters. `evidence_targets` must still name publicly discoverable
   evidence (recent news, government/municipal reports, official
   announcements, public tenders, RTI disclosures, citizen complaint/
   grievance data, open datasets, surveys, reviews) rather than
   inaccessible internal records; `source_strategies` names realistic
   public source *types*; `search_queries` are candidate search-engine
   strings for a future search-execution stage — no search is actually
   run yet. Each hypothesis is also pushed toward specificity (rejecting
   vague claims like "inefficiencies" or "gaps") and toward the scope's
   `location` and `time_scope`: when a `location` is given, the prompt
   requires every hypothesis/query to name it (never inventing one when
   absent), and when `time_scope` is `"current"`, it tells the model to
   prefer "recent"/"latest"/"current" phrasing over hardcoding a year at
   all, only citing one at all for a genuinely historical reference point.
   `search_queries` themselves get the most specific guidance of any
   field: the prompt requires each one to combine the hypothesis's actual
   mechanism/institution/group (never just the lens's generic term) with
   the affected population/place and, where natural, an evidence-type word
   from that hypothesis's own `evidence_targets` — and explicitly forbids
   a query that's just the lens word plus a location (e.g. "coordination
   rural India"), with a concrete example of why that's ambiguous (see
   "Query grounding" below).
4. Validates that JSON against a Zod schema. If validation fails, first
   tries a narrow **deterministic repair** (see below) and re-validates
   before giving up on this attempt. Once schema-valid, runs additional
   deterministic (non-LLM) checks: every `id` is unique, every `lens` is
   used by at most one hypothesis, no two hypotheses are near-identical
   rewordings of each other (word-overlap similarity), no search query is
   repeated verbatim anywhere in the plan, no search query is just the
   lens's own vocabulary plus generic/location filler (see "Query
   grounding" below), and — when `time_scope` is `"current"` — no search
   query references a stale year (older than this year or last year; a
   model hallucinating e.g. "2023" is rejected rather than passed
   downstream). Any violation fails that attempt with a specific error
   instead of silently accepting bad output.
5. If the attempt still failed after the repair pass, retries once more
   (`lib/llm/with-retry.ts`, up to `MAX_ATTEMPTS = 2` total, never more —
   no unbounded loops) before giving up. `format: "json"` only guarantees
   syntactically valid JSON, not a specific shape, so an occasional
   malformed field is expected — asking again is usually enough. Every
   attempt logs its raw model output, whether schema validation passed,
   whether repair was attempted/applied, and the post-repair result; a
   connection failure is never retried.
6. Computes `search_budget` itself, in plain code — not from the model —
   from the scope's `breadth` and the resulting hypothesis count, so it's
   always internally consistent. A future search-execution stage can use
   it to cap how many of each hypothesis's `search_queries` actually run.
7. Prints the validated `ResearchPlan` JSON to the server console, plus a
   summary line with total planner latency and how many of the (max 2)
   LLM attempts were used — e.g.
   `[ProblemRadar/ResearchPlanner] done in 4231ms using 1/2 LLM attempt(s)`.
8. Returns `{ ok: true, plan }` to the client (or `{ ok: false, error }`
   if every attempt failed).

No web search happens here either — the plan only describes what would
be worth investigating, with what evidence, and what someone would search
for to check it. `/api/plan` is independently testable with a
hand-written `IntentScope` (it doesn't require going through `/api/intent`
first); see the `curl` example in `app/api/plan/route.ts`'s comment
header.

**Deterministic repair for a real, observed model quirk.** Real runs
against Qwen3 surfaced a recurring Ollama `format: "json"` bug: a
hypothesis's `"id"` key occasionally comes back corrupted into a stray
punctuation/whitespace-only key (e.g. `{ " ": "h3", ... }` or
`{ ",": "h3", ... }`) while the id's *value* and every other field stay
intact. Rather than rely purely on retries (which just ask a
non-deterministic model to get lucky), `research-planner.ts` includes a
narrow, deterministic repair step between JSON parsing and schema
validation: if a hypothesis is missing a valid `id` but has exactly one
unexpected key that's punctuation/whitespace-only and holds a short,
id-shaped string value, that key is renamed back to `id`. It never
invents a value that wasn't already present, and never touches any other
field — anything less unambiguous is left for schema validation (and
ultimately a retry to the model) to catch instead. This turned a
previously-502 failure into a same-attempt 200 without needing a second,
slower LLM call.

**Provider is shared, not duplicated.** `research-planner.ts` uses the
same `getLLMProvider()` abstraction and the same raw-text parsing helpers
(`lib/llm/json-utils.ts`, shared with `intent-agent.ts`) as stage 1 — no
new provider code was needed to add this stage.

**Query grounding — rejecting ambiguous, lens-word-only queries.** A real
run against the rural-areas query surfaced retrieval-quality problems the
Evidence Analyzer correctly flagged but couldn't fix on its own: a
"coordination" hypothesis's search queries were just `"coordination rural
India"`-shaped strings, which are genuinely ambiguous search terms — they
returned song lyrics, dictionary definitions, and project-management
software instead of evidence about government coordination failures,
because "coordination" alone is a common English word used across many
unrelated domains. The fix has two parts:

1. The prompt (rule 6, above) now spells out what a query needs to
   include and gives a worked example of the exact failure ("coordination
   rural India" vs. a corrected "panchayat block office scheme rollout
   delay coordination rural India"). This is the primary lever, same as
   `LENS_GUIDANCE` is for lens selection.
2. `assertSearchQueriesAreGrounded` (`lib/llm/research-planner.ts`) is a
   deterministic backstop for when the model doesn't follow that
   instruction: for each query, it strips out `GENERIC_QUERY_TERMS`
   (location/filler/evidence-type words like "rural", "report", "current")
   and that hypothesis's own `LENS_WORD_FAMILIES` (the lens's own
   vocabulary — e.g. "coordination", "coordinate", "coordinating" for the
   `coordination` lens), and requires at least one substantive (4+ letter)
   word to still be standing. A query with nothing left after that
   stripping is rejected, failing the attempt and triggering the same
   bounded retry as any other planner validation failure.

   An earlier version of this check instead required a query to share a
   word with its own hypothesis's `hypothesis`/`evidence_targets`/
   `source_strategies` text. Real testing showed that over-fit: a plan's
   second or third query for the same hypothesis is *supposed* to probe a
   different angle in different words (e.g. "healthcare staffing
   government data" alongside "doctor shortage report" for the same
   hypothesis) — reusing none of the hypothesis's exact wording doesn't
   make a query ambiguous, and penalizing that punished exactly the query
   diversity the prompt asks for. Checking the query's own residual
   content (what's left after removing generic/lens words) instead still
   catches the real failure mode without objecting to legitimate synonyms.

   The lens-word exclusion also needed its own fix: a hypothesis's
   `evidence_targets`/`source_strategies` naturally reuses the lens's own
   word (e.g. a coordination hypothesis's evidence_targets legitimately
   says "...coordination complaints"), so an early version of this check
   that only excluded a fixed generic-word list — not the lens's own
   vocabulary — let the exact "coordination rural India" failure back in
   through that loophole. `LENS_WORD_FAMILIES` closes it by excluding each
   lens's own word family specifically, not just generic filler.

   Word comparison uses a small stemmer (`stem()`) so a trivial
   morphological difference ("tracking" vs "track", "spreadsheets" vs
   "spreadsheet") isn't treated as a different word — both the extracted
   query words and the blocklists are stemmed before comparison.

### Search Orchestrator (stage 3)

Takes an already-validated `ResearchPlan` (stage 2's output — `/api/search`
does not depend on stage 2's route or its internal Zod schema, only on the
public `ResearchPlan` shape, so it's independently testable with a
hand-written plan; see the `curl` example in `app/api/search/route.ts`'s
comment header) and executes real, budget-bounded SerpApi searches for
it. **No LLM is involved anywhere in this stage** — it's a deterministic
service, not an agent. `runSearchOrchestrator(plan)`
(`lib/search/search-orchestrator.ts`):

1. Walks every hypothesis's `search_queries`, in order, and for each one
   runs four checks *before* spending a real SerpApi call, in this order:
   (a) has this hypothesis already returned `max_sources_per_hypothesis`
   distinct sources? (b) has this hypothesis already run
   `max_queries_per_hypothesis` queries? (c) has the whole plan already hit
   `total_query_budget`? (d) is this query identical, or a near-duplicate
   (word-overlap similarity ≥ 0.75) of a query already run anywhere else
   in the plan? A query that fails any of these is recorded as a skipped
   `SearchExecution` (`skipped_budget_exhausted` or
   `skipped_duplicate_query`, with a `reason`) and no network call is made
   — the plan's budget is a hard ceiling, never just a suggestion.
2. Only a query that survives all four calls `searchSerpApi(query)`
   (`lib/search/serpapi-client.ts`), the one file that knows SerpApi's
   actual request/response shape. That call is wrapped in its own
   try/catch: a timeout, a rate-limit (429), an auth failure (401/403), a
   non-2xx status, or SerpApi's own `{ "error": "..." }` response body are
   all caught and recorded as an `"error"` `SearchExecution` with a
   `SerpApiError.kind` — **one bad query never aborts the run**, and
   `/api/search` still returns `200` with everything that did succeed.
3. Normalizes whatever comes back into `SearchResult`s (`hypothesis_id`,
   `query`, `title`, `url`, `snippet`, `source`, `position`,
   `published_date`) and deduplicates by canonical URL (protocol,
   `www.`, trailing slash, and query string/hash all ignored) — both
   across queries within one hypothesis and across the whole run, so the
   same source is never counted twice, and enforces
   `max_sources_per_hypothesis` again here (a query can return more raw
   results than the remaining per-hypothesis budget allows).
4. Runs strictly sequentially, with a small configurable politeness delay
   between calls (`SERPAPI_DELAY_MS`) — a deliberate choice for this first
   implementation to stay clear of rate limits; concurrency can be
   revisited once correctness is verified.
5. Logs the incoming plan and budget, every query's outcome (executed /
   skipped-and-why / succeeded-with-N-results / failed-with-what-error),
   and a final summary (`executed X/Y queries, skipped N duplicate + M
   over-budget, kept K results`) to the server console.
6. Returns a `SearchRun` (`types/search.ts`): `started_at`, `completed_at`,
   `duration_ms`, the full ordered `executions` list (one entry per
   (hypothesis, query) pair *considered*, whatever happened to it), all
   kept `results`, and `budget_usage` (a full accounting of the budget:
   queries executed/skipped-duplicate/skipped-budget, and sources kept per
   hypothesis). `POST /api/search` returns this whole `SearchRun` as
   `{ ok: true, run }` — that response *is* the debugging view into what
   the orchestrator did, nothing is summarized away.

Still no scoring, ranking, or synthesis of what's found — this stage ends
at reliable, fully-traceable retrieval and normalization, ready for a
future evidence-analysis stage.

**Local setup required.** This stage needs a real SerpApi API key
(`SERPAPI_API_KEY` in `.env.local` — see `.env.example`) to make real
calls; without one, every query comes back as a graceful per-query
`"error"` execution (`kind: "empty_key"`), not a crash. Get a key at
https://serpapi.com/manage-api-key.

### Evidence Analyzer (stage 4)

Takes an already-validated `ResearchPlan` (stage 2) and its matching
`SearchRun` (stage 3's output — `/api/analyze` does not call SerpApi or
re-run search, and does not depend on either earlier stage's internal
Zod schema, only on their public shapes, so it's independently testable
with hand-written fixtures; see the `curl` example in
`app/api/analyze/route.ts`'s comment header). Unlike the Search
Orchestrator, this stage **does** use the configured LLM (Ollama/Qwen3,
same as stages 1–2) — but only to *interpret* text the SearchRun already
contains, never to search the web or invent anything beyond it.
`runEvidenceAnalyzer(plan, run)` (`lib/llm/evidence-analyzer.ts`):

1. Groups `run.results` by `hypothesis_id`, then processes each
   hypothesis in the plan independently and in order.
2. A hypothesis with zero retrieved results never reaches the model at
   all — that's not a judgment call, so it's handled deterministically
   as `status: "no_evidence"`.
3. Otherwise, numbers that hypothesis's sources (1, 2, 3, ...) and
   prompts the model to return, for **every** source, a `stance`
   ("supports" / "challenges" / "neutral" — the last also covers
   "insufficient evidence to tell"), a `relevance` ("high" / "medium" /
   "low"), and an `evidence_summary` grounded only in that source's own
   title/snippet. The model is asked to reference sources only by their
   number, never by re-typing a URL — the real `url`/`query`/`title`/
   `source` are always taken back from the original `SearchResult` in
   code afterward, never from anything the model echoed, so every
   evidence entry stays exactly traceable to its source. This is the
   same principle behind the Research Planner's `id`-repair pass,
   applied here from the start instead of as a repair.
4. Validates the model's JSON against a Zod schema, then two further
   deterministic checks before accepting it: every source index from
   1..N appears exactly once (no duplicates, none skipped), and every
   `evidence_summary` actually **grounds** in the source it's paired
   with — a word-overlap check (the same Jaccard-style technique used
   elsewhere in this pipeline) that rejects a summary mostly made of
   words absent from that source's own text, i.e. a fabricated claim
   dressed up as an extraction. Either failure fails that attempt and
   (like the other two LLM stages) retries once more
   (`MAX_ATTEMPTS = 2`) before giving up on that one hypothesis.
5. `recency` ("recent" / "dated" / "unknown") is **never** asked of the
   model — it's computed deterministically in code from the source's own
   `published_date` (handling both an absolute date and SerpApi's
   relative phrasing like "3 days ago"; anything unparseable is
   "unknown", never guessed as either recent or dated). This is plain
   date arithmetic, not interpretation, so it's kept out of the LLM's
   hands entirely.
6. One hypothesis's failure — a connection error, or exhausting
   `MAX_ATTEMPTS` of invalid/ungrounded output — is caught right there
   and recorded as `status: "failed"` with an `error` message; it never
   aborts the rest of the run, and `/api/analyze` still returns `200`
   with every other hypothesis's results intact. The same "one bad unit
   of work never aborts the whole run" pattern the Search Orchestrator
   uses for individual queries.
7. `support_count` / `challenge_count` / `neutral_count` on each
   hypothesis are always computed in code from its own `evidence` array
   — never asked of the model — so they can never drift from the
   entries they summarize.
8. Logs the input (hypothesis count, retrieved result count), every
   hypothesis's outcome, and a final summary
   (`X analyzed, Y with no evidence, Z failed`) to the server console —
   the same logging convention as the other three stages.

No scoring, ranking, or problem generation happens here — this stage
ends at structured, source-traceable evidence for a future stage to
build on. It is now called from the workspace UI as the fourth and final
real stage (see "Application wiring" below).

**Provider is shared, not duplicated.** Like the other two LLM stages,
`evidence-analyzer.ts` uses the same `getLLMProvider()` abstraction and
the same raw-text parsing helpers (`lib/llm/json-utils.ts`) — no new
provider code was needed to add this stage.

### Application wiring: Intent → Plan → Search → Analyze → Results

All four stages above were each independently callable and testable, but
nothing on the workspace page ever chained them together — that's what
this wiring does, purely at the application level. No stage's internal
logic, schema, or endpoint changed to support it.

**One sequential handler, not four separate effects.** `handleSubmit()`
in `app/page.tsx` is the single place all four calls happen, in order,
awaited one after another: `requestIntentScope` → `requestResearchPlan`
→ `requestSearchRun` → `requestEvidenceAnalysis` (`lib/api-client.ts`;
the last one just `POST`s the already-validated `ResearchPlan` and
`SearchRun` to `/api/analyze` and returns the `EvidenceAnalysisRun` it
gets back — it never re-plans, re-searches, or duplicates the analyzer's
own classification/validation logic). This function only ever runs from
the input's submit click/keydown, never from a `useEffect`, and the
existing `isSubmitting` guard (`if (!query || isSubmitting) return;`)
now covers the *entire* chain instead of just one call. That combination
— event-triggered only, guarded for its whole duration — is what makes it
structurally impossible for `/api/analyze` (or `/api/search`,
`/api/intent`, or `/api/plan`) to fire twice for one submission, whether
from a React re-render, StrictMode's dev-mode double-invocation, or the
eventual navigation away from `/`. This was verified with an automated
browser test that counts actual network requests, not just reasoned
about — see below.

**Per-hypothesis failure is not a page-level error.** The Evidence
Analyzer's own isolation guarantee (each hypothesis analyzed
independently; one hypothesis's failure never fails the request — see
"Evidence Analyzer (stage 4)" above) means `/api/analyze` almost always
returns `200`/`ok: true`, even if, say, the LLM is completely unreachable
for that call — every hypothesis simply comes back with
`status: "failed"` and its own `error` message instead. The wiring
respects that: `requestEvidenceAnalysis` only throws (triggering the
page-level error banner) on a genuine transport/response failure of
`/api/analyze` itself, never because some hypotheses failed to analyze.
A hypothesis-level failure is instead surfaced in place, in
`EvidenceAnalysisPanel`, as an "Analysis failed" badge with its error
message — the rest of the run's evidence still renders normally. This
was confirmed directly: stopping the LLM before calling `/api/analyze`
with a real plan+run still returned `200`/`ok: true`, with every
hypothesis marked `"failed"`.

**Handing results to `/results` without a backend.** There's still no
database, so `lib/pipeline-store.ts` is a small module-level singleton
(`setPipelineResult` / `getPipelineResult`) that holds the just-completed
`{ query, intent, plan, searchRun, analysis }` in memory. `handleSubmit`
calls `setPipelineResult(...)` right before navigating; `/results` calls
`getPipelineResult()` once, via lazy `useState` initialization, when it
mounts. This is deliberately not a state-management library or a React
context — just the smallest thing that survives a client-side route
change within the same tab. It's safe across Next.js App Router
navigation because that transition doesn't re-run the server render (the
module stays alive in the browser's JS runtime); a genuine full page
reload resets it to `null` on both server and client consistently, so
there's no hydration mismatch — it just falls back to showing the mock
`ProblemCard`s only, exactly like before this wiring existed.

**Loading state.** While `handleSubmit` runs, a `statusMessage` string
cycles through "Understanding your request…" → "Planning your
research…" → "Searching sources…" → "Analyzing evidence…", shown next
to a spinning `Loader2` icon (`role="status" aria-live="polite"`) below
the input, in addition to the existing submit button's own
"Discovering..." state.

**Error state.** No new error UI was needed: the existing red
`role="alert"` message below the input already fires from the `catch`
block wrapping the whole chain, and `requestEvidenceAnalysis`'s thrown
error message ("The Evidence Analyzer could not process this request.")
is just as stage-distinctive as the existing Intent/Plan/Search failure
messages, so a genuine `/api/analyze`-level failure reads clearly as an
analysis-stage failure rather than a generic one — and, per the point
above, this is a rarer case than an individual hypothesis failing, which
never shows this banner at all.

**Verification.** In addition to the full lens-fix regression suite (31
assertions) and the earlier stage 1→2→3 wiring's own end-to-end test (20
assertions), an automated Playwright end-to-end test drove a real
Chromium browser through the exact query "Show me real problems worth
solving right now in rural areas" — typing it, submitting, watching the
loading state (including "Analyzing evidence…"), following the `/` →
`/research` → `/results` navigation, and asserting on the rendered
Search Evidence *and* Evidence Analysis panels — while also listening to
the browser's own network and console events. That test (24 assertions,
all passing, run repeatedly against a freshly restarted dev server)
confirmed exactly one call each to `/api/intent`, `/api/plan`,
`/api/search`, and `/api/analyze`, each returning `200`, in that exact
order. Running it against `npm run dev` also confirmed the acceptance
criterion that the terminal shows each request logged in sequence:

```
POST /api/intent 200 in 332ms (next.js: 228ms, application-code: 104ms)
POST /api/plan 200 in 51ms (next.js: 31ms, application-code: 20ms)
POST /api/search 200 in 103ms (next.js: 27ms, application-code: 76ms)
POST /api/analyze 200 in 344ms (next.js: 285ms, application-code: 59ms)
```

## What is intentionally not implemented yet

- No database or persistence of any kind — `lib/pipeline-store.ts`'s
  in-memory handoff to `/results` does not survive a page reload, and
  isn't meant to
- No authentication or user accounts
- No problem-detection, scoring, or ranking logic yet — the Evidence
  Analyzer (`POST /api/analyze`) is now wired into the workspace flow
  and its output is rendered on `/results` via `EvidenceAnalysisPanel`,
  but nothing yet turns that evidence into scored/ranked problems; recurrence
  levels and evidence counts on `/results` are still hand-authored mock
  values, and the `/research` stage list is still a timer, not real
  progress
- No global state management library (local `useState` only)

See `docs/UI-ARCHITECTURE.md` for how the UI flow and components fit
together, and `docs/DEVELOPMENT.md` for how to run the project and add
to it.
