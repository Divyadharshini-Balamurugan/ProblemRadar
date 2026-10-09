# Development Guide

## Requirements and commands

Use Node.js 20.9 or newer (the minimum required by the installed Next.js 16 version).

```bash
npm install
npm run dev
```

The app is available at `http://localhost:3000`. Other project scripts:

```bash
npm run build                  # production build
npm run start                  # serve the production build
npm run lint                   # ESLint
npm test                       # compile and run both unit-test files
npm run test:problem-generator # candidate problem generator tests
npm run test:gap-analysis      # gap-analysis tests
```

There is no `check:ollama` script in the current `package.json`; use the Ollama commands below to check setup manually.

## Configure Ollama

Stages 1, 2, 4, and 5 use the configured LLM provider. The current provider is Ollama, with defaults of `http://localhost:11434`, model `qwen3:8b`, and a 240-second request timeout.

1. Install Ollama from [ollama.com/download](https://ollama.com/download) and start its server.
2. Pull the configured model:

   ```bash
   ollama pull qwen3:8b
   ```

3. Start the app and submit a query. Server-side request and model logs appear in the terminal running the app.

Copy `.env.example` to `.env.local` to change `LLM_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, or `OLLAMA_TIMEOUT_MS`. The API route handlers and LLM services run server-side; do not rename secret settings with a `NEXT_PUBLIC_` prefix.

Gap Analysis also calls the same LLM provider, but it is currently an independent endpoint and is not invoked from the workspace flow.

## Configure SerpApi

Stages 3 and 6 use SerpApi for web search. Set a key in `.env.local`:

```text
SERPAPI_API_KEY=your-key
```

The defaults and optional settings are in `.env.example`: `SERPAPI_BASE_URL`, `SERPAPI_TIMEOUT_MS`, `SERPAPI_RESULTS_PER_QUERY`, and `SERPAPI_DELAY_MS`. Without a key, stage 3 records each search as a per-query error and can still return a `SearchRun`; it will not produce real sources for analysis or candidate generation. Stage 6 similarly requires usable SerpApi results to analyze solutions and gaps.

Search uses the same SerpApi configuration for both stages. The gap analyzer makes up to five focused searches per candidate, requests five results per query, and keeps at most eight unique source items per candidate. It can be called directly with `POST /api/analyze-gaps`, but the workspace does not currently make that call.

## Current workspace execution

Submitting `/` runs these calls sequentially:

1. `POST /api/intent` — query to structured intent/scope.
2. `POST /api/plan` — intent/scope to research hypotheses and a budget.
3. `POST /api/search` — plan to normalized web results and execution accounting.
4. `POST /api/analyze` — plan and search results to source-level evidence analysis.
5. `POST /api/generate-problems` — plan and analysis to candidate problems.

Only after these calls finish does the app save the outputs in the client-side `lib/pipeline-store.ts` and navigate to `/research`. That page is a timed visual progression, not live server progress. `/results` renders the search/evidence outputs when the in-memory store is present, but candidate problems are currently only logged; the problem cards still use `MOCK_PROBLEMS`. Reloading clears the store.

`POST /api/analyze-gaps` is stage 6 in the overall capability set, but is not called by the workspace. `requestGapAnalysis()` is already available in `lib/api-client.ts`. Wiring it into the flow requires sending the generated candidate problems to it, adding its result to the pipeline handoff, and presenting its `GapAnalysisResult` in the UI.

## Where code belongs

| Change | Location |
| --- | --- |
| Page or route handler | `app/<route>/page.tsx` or `app/api/<name>/route.ts` |
| Shared layout | `app/<segment>/layout.tsx` |
| ProblemRadar-specific component | `components/<kebab-case-name>.tsx` |
| Generic UI primitive | `components/ui/<name>.tsx` |
| LLM provider/agent/service | `lib/llm/` |
| Search configuration, client, or orchestration | `lib/search/` |
| API request wrapper used by the browser | `lib/api-client.ts` |
| Shared data shape | `types/<domain>.ts`, exported from `types/index.ts` |
| Static/mocked UI data | `lib/mock-data.ts` |
| Tests | `tests/` |
| Project documentation | `docs/` |

Keep route handlers responsible for request validation and HTTP responses. Put pipeline behavior in `lib/` services so it can be called independently and tested with injected dependencies. Keep third-party request/response details inside their client modules.

## LLM service pattern

The Intent Agent, Research Planner, Evidence Analyzer, Problem Generator, and Gap Analyzer share the `LLMProvider` contract in `lib/llm/provider.ts`. They obtain the provider from `getLLMProvider()` rather than calling Ollama directly. The Ollama-specific HTTP handling lives in `lib/llm/providers/ollama-provider.ts`.

For a new LLM-backed stage:

1. Define its request/result types in `types/` and export them from `types/index.ts`.
2. Validate the API request with a route-local Zod schema.
3. Put the prompt and business logic in a service under `lib/llm/`.
4. Parse model text with helpers in `lib/llm/json-utils.ts` and validate the output with Zod plus deterministic checks where needed.
5. Use `withRetry()` only for recoverable invalid model output. Do not retry a provider connection failure as though it were malformed JSON.
6. For independent work units, isolate failures at that unit (query, hypothesis, or candidate) and return status/error information with the successful work.
7. Add focused tests using injected providers and search functions rather than external services.

## Search/service pattern

`lib/search/serpapi-client.ts` isolates SerpApi's network and response format. `lib/search/search-orchestrator.ts` owns query budgeting, deduplication, normalization, and per-query outcomes. Gap Analysis reuses the SerpApi client while building its own candidate-specific query plan in `lib/llm/gap-analyzer.ts`.

Keep API keys server-only and configuration centralized. For any new external call, set a timeout and return useful per-unit failure data where the rest of the run can continue.

## UI conventions

- App Router pages and layouts follow the installed Next.js documentation under `node_modules/next/dist/docs/`; repository-specific requirements are in `AGENTS.md`.
- Use server components by default. Add `"use client"` for components that need state, effects, browser APIs, or client navigation hooks.
- Product-specific UI belongs in `components/`; reusable primitives belong in `components/ui/`.
- Keep `types/` independent of React and service implementation details.
- When page flow or data handoff changes, update `docs/README.md` and `docs/UI-ARCHITECTURE.md` in the same change.
