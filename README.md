# ProblemRadar

ProblemRadar is a research application for exploring real-world problems with public evidence. The workspace currently runs five stages: query understanding, research planning, SerpApi search, evidence analysis, and evidence-grounded candidate problem generation.

A sixth capability analyzes existing solutions and evidence-backed gaps through `POST /api/analyze-gaps`. It is implemented but not yet called by the workspace. Candidate problems are generated and saved in the current run, but the results page still shows the illustrative mock problem cards rather than those generated candidates.

Built with Next.js App Router, TypeScript, Tailwind CSS v4, Radix UI primitives, Ollama, SerpApi, and Zod.

## Run locally

Requires Node.js 20.9 or newer. Configure Ollama with the `qwen3:8b` model and set `SERPAPI_API_KEY` in `.env.local` for real search results.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Documentation

- [Project and pipeline overview](./docs/README.md)
- [UI and pipeline architecture](./docs/UI-ARCHITECTURE.md)
- [Development setup and conventions](./docs/DEVELOPMENT.md)
