import { SERPAPI_CONFIG } from "./config";

/**
 * Distinguishes *why* a SerpApi call failed, so the orchestrator can log
 * (and eventually let the UI show) something more useful than a bare
 * exception. Never thrown across a whole search run — always caught and
 * recorded per (hypothesis, query) pair by the Search Orchestrator.
 */
export type SerpApiErrorKind =
  | "empty_key"
  | "auth"
  | "rate_limited"
  | "timeout"
  | "network"
  | "http_error"
  | "unknown";

export class SerpApiError extends Error {
  constructor(
    message: string,
    public readonly kind: SerpApiErrorKind
  ) {
    super(message);
    this.name = "SerpApiError";
  }
}

/** One organic result exactly as normalized out of SerpApi's response — still raw, not yet a `SearchResult` (the orchestrator attaches hypothesis_id/query and does URL-dedup). */
export interface RawSearchItem {
  title: string;
  link: string;
  snippet: string;
  source: string;
  position: number;
  date: string | null;
}

interface SerpApiOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  displayed_link?: string;
  position?: number;
  date?: string;
}

interface SerpApiResponseBody {
  organic_results?: SerpApiOrganicResult[];
  /** SerpApi sometimes reports a problem this way even with a 200 status (e.g. "no results", account issues). */
  error?: string;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * This is the only file that knows SerpApi's actual request/response
 * shape — the Search Orchestrator only ever sees `RawSearchItem[]` or a
 * `SerpApiError`, never SerpApi's own field names or status codes. No LLM
 * involved anywhere in this module.
 */
export async function searchSerpApi(
  query: string,
  options?: { numResults?: number }
): Promise<RawSearchItem[]> {
  if (!SERPAPI_CONFIG.apiKey) {
    throw new SerpApiError(
      "SERPAPI_API_KEY is not set — add it to .env.local to enable real web search (see .env.example).",
      "empty_key"
    );
  }

  const numResults = options?.numResults ?? SERPAPI_CONFIG.resultsPerQuery;

  const url = new URL(SERPAPI_CONFIG.baseUrl);
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(numResults));
  url.searchParams.set("api_key", SERPAPI_CONFIG.apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERPAPI_CONFIG.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url.toString(), { signal: controller.signal });
  } catch (cause) {
    const isAbort = cause instanceof Error && cause.name === "AbortError";
    throw new SerpApiError(
      isAbort
        ? `SerpApi did not respond within ${SERPAPI_CONFIG.timeoutMs}ms for query "${query}".`
        : `Could not reach SerpApi for query "${query}": ${cause instanceof Error ? cause.message : String(cause)}`,
      isAbort ? "timeout" : "network"
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429) {
    throw new SerpApiError(`SerpApi rate-limited this request for query "${query}" (429).`, "rate_limited");
  }
  if (response.status === 401 || response.status === 403) {
    throw new SerpApiError(
      `SerpApi rejected the API key for query "${query}" (${response.status}). Check SERPAPI_API_KEY.`,
      "auth"
    );
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new SerpApiError(
      `SerpApi returned ${response.status} ${response.statusText} for query "${query}".${bodyText ? ` ${bodyText}` : ""}`.trim(),
      "http_error"
    );
  }

  const data = (await response.json().catch(() => ({}))) as SerpApiResponseBody;

  if (data.error) {
    const lowerError = data.error.toLowerCase();
    const kind: SerpApiErrorKind = lowerError.includes("key")
      ? "auth"
      : lowerError.includes("rate") || lowerError.includes("limit") || lowerError.includes("quota")
        ? "rate_limited"
        : "unknown";
    throw new SerpApiError(`SerpApi reported an error for query "${query}": ${data.error}`, kind);
  }

  const organicResults = data.organic_results ?? [];

  return organicResults
    .filter((item): item is SerpApiOrganicResult & { title: string; link: string } => Boolean(item.title && item.link))
    .slice(0, numResults)
    .map((item, index) => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet ?? "",
      source: item.source ?? item.displayed_link ?? hostnameOf(item.link),
      position: item.position ?? index + 1,
      date: item.date ?? null,
    }));
}
