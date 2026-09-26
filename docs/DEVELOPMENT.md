# Development Guide

## Running the project

```bash
npm install
npm run dev
```

The app runs at `http://localhost:3000`. Other scripts:

```bash
npm run build         # production build (also type-checks)
npm run start          # run the production build
npm run lint            # ESLint
npm run check:ollama     # confirm Ollama is running + pull the model if missing
```

Requires Node.js 18.18+ (Node 20 LTS or newer recommended).

## One-time setup for the Intent/Scope Agent + Research Planner (Ollama)

Submitting the workspace input now runs all three real backend stages in
sequence — Intent/Scope Agent, then Research Planner, then the Search
Orchestrator (see "Application wiring" in `docs/README.md`) — so this
one-time setup (plus the SerpApi setup below) is required before
`npm run dev` will produce results instead of an error banner under the
input:

1. Install Ollama from https://ollama.com/download (Windows, macOS, or
   Linux). On Windows/macOS it starts automatically in the background
   after install; on Linux run `ollama serve` in a terminal.
2. Pull the model the agent expects:
   ```bash
   ollama pull qwen3:8b
   ```
   or just run `npm run check:ollama`, which checks Ollama is reachable
   and pulls the model for you if it's missing.
3. Start the app as normal (`npm run dev`) and submit something on `/`.
   You should see request/response logging in the **terminal running
   `npm run dev`** (not the browser console) for each stage in order:
   the raw text you typed and the parsed Intent/Scope JSON from
   `/api/intent`, then that same Intent/Scope JSON and the generated
   ResearchPlan JSON from `/api/plan`, then the plan's search queries and
   a `SearchRun` summary from `/api/search`, then that same plan and
   SearchRun and the resulting per-hypothesis evidence from
   `/api/analyze` — plus a per-request status line
   (`POST /api/intent 200 in ...`) for each, since this only appears
   under `next dev`, not `next start`.

If Ollama isn't running or the model isn't pulled, submitting the input
shows a clear error message under the textarea instead of failing
silently — the error text tells you exactly what to fix (this applies to
any of the four stages; each call only happens after the previous one
has already succeeded). Note that the Evidence Analyzer (stage 4) is an
exception in practice: it isolates failures per hypothesis rather than
throwing, so a completely unreachable Ollama still returns a successful
`/api/analyze` response with every hypothesis marked `"failed"` — see
"Application wiring" in `docs/README.md`.

To point at a different model or a remote Ollama instance, copy
`.env.example` to `.env.local` and adjust `OLLAMA_BASE_URL` /
`OLLAMA_MODEL`. No other code changes are needed.

## One-time setup for the Search Orchestrator (SerpApi)

`POST /api/search` (stage 3) needs a real SerpApi key to make real
searches — it does not use Ollama or any LLM.

1. Get a key at https://serpapi.com/manage-api-key (SerpApi has a free
   tier with a monthly search allowance, enough for local development).
2. Copy `.env.example` to `.env.local` (if you haven't already) and set
   `SERPAPI_API_KEY=<your key>`.
3. Submitting the workspace input now calls `/api/search` automatically
   after `/api/plan` succeeds (see "Application wiring" in
   `docs/README.md`), so a real key here is what turns the Search
   Evidence panel on `/results` from all-`"error"` executions into real
   results. You can still call `/api/search` directly with a hand-written
   `ResearchPlan` for isolated testing — see the `curl` example in
   `app/api/search/route.ts`'s comment header. It does not require going
   through `/api/intent` or `/api/plan` first.

Without a key, every query comes back as a graceful per-query `"error"`
execution (`SerpApiError` with `kind: "empty_key"`) instead of a crash —
useful for exercising the orchestrator's dedup/budget logic without
spending real API quota, but you won't get real results back that way.
`SERPAPI_TIMEOUT_MS`, `SERPAPI_RESULTS_PER_QUERY`, and `SERPAPI_DELAY_MS`
(see `.env.example`) tune the same stage without any code changes.

## Where things belong

| If you're adding...                                   | It goes in...                          |
| ------------------------------------------------------- | ---------------------------------------- |
| A new route / page                                      | `app/<route>/page.tsx`                    |
| A layout shared by a route segment                       | `app/<route>/layout.tsx`                  |
| A ProblemRadar-specific, reusable UI piece                | `components/<kebab-case-name>.tsx`         |
| A generic shadcn/ui primitive (Button, Dialog, etc.)      | `components/ui/<name>.tsx`                 |
| A pure helper function / class-merging util                | `lib/`                                     |
| Mock or real data-fetching helpers                         | `lib/`                                     |
| A new API route (server-side only logic)                    | `app/api/<name>/route.ts`                    |
| LLM provider code or a new agent                             | `lib/llm/` (see below)                        |
| A shared TypeScript type/interface                        | `types/<domain>.ts`, re-exported from `types/index.ts` |
| Static assets (images, icons, fonts)                        | `public/`                                  |
| Project documentation                                       | `docs/`                                    |

Page files (`app/**/page.tsx`) should stay focused on composing
components and owning page-level state (e.g. what's in the URL, what a
mock timer is doing) — the actual UI building blocks belong in
`components/`.

## Adding a new shadcn/ui component

This project's `components/ui/` primitives are hand-authored to match
the standard shadcn/ui API (Radix UI primitive + `class-variance-authority`
+ the shared `cn()` helper from `lib/utils.ts`), because the shadcn CLI's
registry (`ui.shadcn.com`) may not be reachable from every network this
project is developed on. `components.json` is still present and
shadcn-CLI-compatible, so if you have registry access, you can use the
CLI as normal:

```bash
npx shadcn@latest add dialog
```

If the CLI can't reach the registry, add a component by hand instead:

1. Install its Radix primitive (and any other runtime dependency) via
   npm, e.g. `npm install @radix-ui/react-dialog`.
2. Create `components/ui/<name>.tsx` following the pattern already used
   in this folder: a thin wrapper around the Radix primitive, styled
   with Tailwind utility classes and the `cn()` helper, exporting one
   named function per sub-part (e.g. `Dialog`, `DialogTrigger`,
   `DialogContent`).
3. Reference the official shadcn/ui docs (https://ui.shadcn.com/docs/components)
   for the exact class names/structure of the component you're adding,
   so it stays visually consistent with the rest of the kit.
4. Import it in ProblemRadar-specific components the same way as the
   existing primitives: `import { Dialog } from "@/components/ui/dialog"`.

Never introduce a different component library (Chakra, MUI, Ant, etc.)
alongside shadcn/ui — pick the closest existing primitive or add a new
shadcn-style one instead.

## Adding a new LLM agent or provider

`lib/llm/intent-agent.ts`, `lib/llm/research-planner.ts`, and
`lib/llm/evidence-analyzer.ts` are three worked examples of the same
pattern — follow it for the next agent:

1. Define its output shape in `types/` (see `types/intent.ts` or
   `types/research-plan.ts`).
2. Write a Zod schema for that shape, and a system prompt + prompt
   builder function describing exactly what JSON to return.
3. Call `getLLMProvider()` (`lib/llm/index.ts`) and its
   `generateJSON({ system, prompt })` — never call `fetch` to an LLM
   endpoint directly from an agent or a route.
4. Parse the raw text defensively using the shared helpers in
   `lib/llm/json-utils.ts` (`stripThinking`, `extractJsonObject`), then
   validate with your Zod schema. Throw a typed error (see
   `IntentParseError` / `ResearchPlanParseError`) on failure rather than
   passing unvalidated data downstream.
5. If the stage has rules a JSON schema can't express on its own (e.g.
   "no two items may be near-duplicates," as in the Research Planner's
   `assertHypothesesAreSound`, or "this text must actually derive from
   the source it claims to summarize," as in the Evidence Analyzer's
   `isGrounded` check), add a plain-code check after schema validation
   rather than trusting the model to self-police it — throw the same
   typed parse error on violation so callers handle it one way.
6. Call the agent from an `app/api/<name>/route.ts` route handler, which
   should validate its own request body with Zod and log both the input
   and the validated output to the server console.
7. If one call covers several independent units of work (the Evidence
   Analyzer calls the model once per hypothesis), wrap each unit's call
   in its own try/catch and record a per-unit failure outcome instead of
   letting one bad unit fail the whole request — same principle as the
   Search Orchestrator's per-query error handling, just applied to an
   LLM call instead of a third-party API call.

To add a **second provider** (a hosted API, a different local runtime):
write a new class in `lib/llm/providers/` implementing `LLMProvider`
(`lib/llm/provider.ts`), then add one `case` to the switch in
`getLLMProvider()` (`lib/llm/index.ts`). No agent or route code should
need to change — that's the point of coding against the interface
instead of a specific provider's SDK.

## Adding a deterministic (non-LLM) service stage

`lib/search/` (stage 3, the Search Orchestrator) is the worked example
for a pipeline stage that's plain deterministic code, not an LLM agent —
follow it for the next one (e.g. an evidence-analysis stage that just
filters/groups already-fetched results without calling a model):

1. Define its output shape in `types/` (see `types/search.ts`), same as
   an agent stage.
2. Put env-driven config (API keys, timeouts, tunable limits) in its own
   `config.ts`, read via a single exported const object — never
   `process.env` scattered through the rest of the module. Never expose
   an API key to the client; these modules are only ever imported from
   server code (route handlers, other `lib/` services).
3. Isolate the third-party API's actual request/response shape in one
   client file (see `serpapi-client.ts`) with a typed error class
   (`kind` field for distinguishing failure modes) — nothing else in the
   app should know that shape.
4. Put the orchestration logic (budgeting, deduplication, sequencing,
   normalization) in its own module, and wrap every external call in its
   own try/catch so one failure never aborts the whole run — record it as
   a typed outcome instead of throwing out of the function.
5. Call it from an `app/api/<name>/route.ts` route handler with its own
   Zod request schema — don't import another stage's internal/unexported
   schema; depend only on the shared `types/` shape so stages stay
   independently testable and swappable.
6. Log the input, every unit of work's outcome, and a final summary to
   the server console, same as the LLM agents do.

## Naming and structure rules

- **Components**: kebab-case filenames (`problem-card.tsx`), one
  component's primary export per file, PascalCase export name
  (`ProblemCard`).
- **`components/ui/`** is reserved for generic, ProblemRadar-agnostic
  primitives only. If a component encodes ProblemRadar concepts (a
  "Problem," a "research stage," a "Quick Start option"), it belongs in
  `components/`, not `components/ui/`.
- **Types**: one file per domain in `types/` (`problem.ts`,
  `research.ts`, `exploration.ts`, `intent.ts`), all re-exported from
  `types/index.ts` so consumers can `import type { Problem } from "@/types"`.
- **Mock data**: keep all of it in `lib/mock-data.ts` for now. If it
  grows unwieldy, split by domain (`lib/mock-problems.ts`, etc.) rather
  than inlining mock arrays inside components or pages. (This does not
  apply to `lib/llm/` — that's real logic, not mock data.)
- **No premature abstraction**: don't add hooks, context providers, or a
  state-management library until an actual page needs them. `useState`
  in the owning page is enough for this MVP. API routes and `lib/llm/`
  are the exception — they exist because the Intent/Scope Agent and
  Research Planner genuinely need server-side code (API keys/local ports
  shouldn't be reachable from the client, and LLM calls shouldn't block
  rendering).
- **Client vs. server components**: default to server components
  (no `"use client"`). Add `"use client"` only to components that use
  state, effects, or browser-only APIs (e.g. `ExplorationInput`,
  `QuickStartOptions`, `ProblemCard`, and the two pages that read
  `useSearchParams`). Route handlers under `app/api/` are always
  server-only regardless of this rule.

## Keeping docs in sync

Whenever you add, remove, or move a page or a component in a way that
changes the folder structure or the page flow, update:

- `docs/README.md` — folder structure, page list, or scope
  (implemented vs. not-yet-implemented) if either changed.
- `docs/UI-ARCHITECTURE.md` — the page flow diagram or a component's
  responsibility if you changed how data moves between pages/components.

Small documentation is easy to keep honest — prefer trimming stale
sentences over letting them drift.
