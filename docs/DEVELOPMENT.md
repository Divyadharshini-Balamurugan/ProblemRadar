# Development Guide

## Running the project

```bash
npm install
npm run dev
```

The app runs at `http://localhost:3000`. Other scripts:

```bash
npm run build   # production build (also type-checks)
npm run start   # run the production build
npm run lint    # ESLint
```

Requires Node.js 18.18+ (Node 20 LTS or newer recommended).

## Where things belong

| If you're adding...                                   | It goes in...                          |
| ------------------------------------------------------- | ---------------------------------------- |
| A new route / page                                      | `app/<route>/page.tsx`                    |
| A layout shared by a route segment                       | `app/<route>/layout.tsx`                  |
| A ProblemRadar-specific, reusable UI piece                | `components/<kebab-case-name>.tsx`         |
| A generic shadcn/ui primitive (Button, Dialog, etc.)      | `components/ui/<name>.tsx`                 |
| A pure helper function / class-merging util                | `lib/`                                     |
| Mock or (later) real data-fetching helpers                | `lib/`                                     |
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

## Naming and structure rules

- **Components**: kebab-case filenames (`problem-card.tsx`), one
  component's primary export per file, PascalCase export name
  (`ProblemCard`).
- **`components/ui/`** is reserved for generic, ProblemRadar-agnostic
  primitives only. If a component encodes ProblemRadar concepts (a
  "Problem," a "research stage," a "Quick Start option"), it belongs in
  `components/`, not `components/ui/`.
- **Types**: one file per domain in `types/` (`problem.ts`,
  `research.ts`, `exploration.ts`), all re-exported from `types/index.ts`
  so consumers can `import type { Problem } from "@/types"`.
- **Mock data**: keep all of it in `lib/mock-data.ts` for now. If it
  grows unwieldy, split by domain (`lib/mock-problems.ts`, etc.) rather
  than inlining mock arrays inside components or pages.
- **No premature abstraction**: don't add hooks, context providers, API
  routes, or a state-management library until an actual page needs
  them. `useState` in the owning page is enough for this MVP.
- **Client vs. server components**: default to server components
  (no `"use client"`). Add `"use client"` only to components that use
  state, effects, or browser-only APIs (e.g. `ExplorationInput`,
  `QuickStartOptions`, `ProblemCard`, and the two pages that read
  `useSearchParams`).

## Keeping docs in sync

Whenever you add, remove, or move a page or a component in a way that
changes the folder structure or the page flow, update:

- `docs/README.md` — folder structure, page list, or scope
  (implemented vs. not-yet-implemented) if either changed.
- `docs/UI-ARCHITECTURE.md` — the page flow diagram or a component's
  responsibility if you changed how data moves between pages/components.

Small documentation is easy to keep honest — prefer trimming stale
sentences over letting them drift.
