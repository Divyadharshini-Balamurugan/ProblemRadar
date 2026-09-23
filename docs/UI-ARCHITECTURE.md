# UI Architecture

This document explains how the three pages fit together, what each
component is responsible for, and how data flows between them today
(all client-side, all mock).

## Page flow

```
 /                     /research?q=...           /results?q=...
 ┌────────────────┐    ┌────────────────────┐    ┌───────────────────┐
 │ Workspace        │──▶│ Research progress    │──▶│ Results             │
 │ (page.tsx)        │    │ (research/page.tsx)  │    │ (results/page.tsx)  │
 └────────────────┘    └────────────────────┘    └───────────────────┘
```

1. The user types a query (optionally guided by a Quick Start option or
   chip) on `/` and submits it.
2. `router.push` navigates to `/research?q=<query>`, passing the query
   through the URL — there is no shared client state or backend call
   between pages.
3. `/research` simulates a multi-stage research run and, once "complete,"
   lets the user continue to `/results?q=<query>`.
4. `/results` reads `q` back out of the URL (for display only) and
   renders the mock `Problem[]` list.

Passing the query via the URL (rather than a store or context) keeps
each route independently loadable and keeps the door open for `/results`
and `/research` to become server-rendered against a real API later
without a state-management rewrite.

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
about what happens after submit.

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

### `components/ui/*`

shadcn/ui-style primitives only (Button, Card, Textarea, Badge,
Separator, Progress, Tabs, Skeleton, Tooltip). These have no
ProblemRadar-specific logic and should stay that way — anything
domain-specific belongs in `components/`, not `components/ui/`.

## State ownership

There is no global store. Each page owns the state relevant to it:

- `app/page.tsx` — the input text, and which Quick Start option/chip is
  active.
- `app/research/page.tsx` — the mock stage array and whether the mock
  run has finished.
- `app/results/page.tsx` — no local state; `Tabs` manages its own
  selected-filter state internally (uncontrolled).

## Data flow

```
types/  ──defines shapes──▶  lib/mock-data.ts  ──imported by──▶  components / pages
```

`types/` has no dependencies on React or mock data — it only describes
shapes (`Problem`, `ResearchStage`, `QuickStartOption`, etc.). This is
what makes it safe to later replace `lib/mock-data.ts` with a real data
source (an API client, a server action) without changing any component:
as long as the new source returns the same shapes, the UI is unaffected.
