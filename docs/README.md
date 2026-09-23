# ProblemRadar

ProblemRadar is a research product that helps builders, founders, and
product teams discover **real, evidence-backed problems** worth solving —
before they write a single line of application code. Instead of guessing
what to build, a user describes what they're curious about (a person, an
industry, a location, or a problem they already suspect exists), and
ProblemRadar is meant to search real sources, cluster recurring
complaints, and surface validated problem opportunities with the
evidence behind them.

This repository currently contains **the MVP user interface only**.

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
3. **Results (`/results`)** — a placeholder results page rendering
   reusable `ProblemCard` components (title, description, recurrence
   badge, evidence count, "View Evidence" toggle) from mock data, with
   tabs to filter by recurrence level.

**Nothing in this repo talks to a backend.** There is no database, no
authentication, no AI/LLM calls, no SerpAPI integration, and no real
research logic. All problem and stage data comes from
`lib/mock-data.ts`.

## Technology stack

- **Next.js** (App Router) + **TypeScript**
- **Tailwind CSS v4** for styling, using CSS variables for theming
  (see `app/globals.css`)
- **shadcn/ui**-style components (Radix UI primitives + `class-variance-authority`,
  hand-authored under `components/ui/` to match the standard shadcn/ui
  API) — Button, Card, Textarea, Badge, Separator, Progress, Tabs,
  Skeleton, Tooltip
- **lucide-react** for icons
- No other component library, CSS framework, state manager, or data
  layer is used

## Folder structure

```
app/                     Routes and layouts (App Router)
  layout.tsx              Root layout: fonts, metadata, shared header
  page.tsx                 Workspace ("What do you want to discover?")
  research/page.tsx        Research progress state
  results/page.tsx         Placeholder results page
components/               ProblemRadar-specific reusable components
  problem-radar-header.tsx
  exploration-input.tsx
  quick-start-options.tsx
  research-progress.tsx
  problem-card.tsx
  results-summary.tsx
  ui/                      shadcn/ui primitives only (Button, Card, ...)
lib/                       Utilities and future service helpers
  utils.ts                 cn() class-merging helper
  mock-data.ts              All mock data used by the UI today
types/                     Shared TypeScript types
  exploration.ts, research.ts, problem.ts, index.ts
public/                    Static assets
docs/                       This documentation
```

## Available pages

| Route        | Purpose                                            |
| ------------ | --------------------------------------------------- |
| `/`          | Main ProblemRadar workspace and entry point          |
| `/research`  | Mock research-in-progress state (stage list + bar)   |
| `/results`   | Mock results list of `ProblemCard`s, filterable      |

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

## Current mock-data approach

Every piece of dynamic-looking content — Quick Start options, chips,
research stages, and the six sample problems shown on `/results` — lives
in `lib/mock-data.ts` and is typed against the shapes in `types/`. There
is no fetching, caching, or persistence; components simply import and
render this data (or receive it as props). This keeps the UI fully
functional and demoable while making the eventual swap to real data a
matter of replacing the data source, not the components.

## What is intentionally not implemented yet

- No backend, API routes, or server actions
- No database or persistence of any kind
- No authentication or user accounts
- No AI/LLM integration
- No SerpAPI or any external search integration
- No real problem-detection, evidence-analysis, or recurrence-scoring
  logic — recurrence levels and evidence counts on `/results` are
  hand-authored mock values
- No global state management library (local `useState` only)

## Planned future flow

The UI is structured so the following pipeline can be wired in later
without restructuring pages or components:

```
User question
  → Intent parser        (interprets the free-text query + Quick Start context)
  → Research planner      (turns intent into concrete research directions)
  → SerpAPI                 (executes searches against real sources)
  → Evidence analysis     (extracts and clusters recurring complaints)
  → Problem detection      (scores recurrence, assembles Problem records)
  → Results UI              (already built — renders `Problem[]` via `ProblemCard`)
```

Each stage above corresponds conceptually to one row in `RESEARCH_STAGES`
(`lib/mock-data.ts`) and the `ResearchStage` type. Connecting real data
means: adding a service under `lib/` that performs the pipeline (likely
behind an API route or server action), replacing the mock `useEffect`
timer in `app/research/page.tsx` with real stage updates (e.g. via
polling or streaming), and replacing `MOCK_PROBLEMS` with the API's
response — the `Problem` type is already shaped for this.

See `docs/UI-ARCHITECTURE.md` for how the UI flow and components fit
together, and `docs/DEVELOPMENT.md` for how to run the project and add
to it.
