import Link from "next/link";
import { Radar } from "lucide-react";

/**
 * Site-wide top bar. Static/presentational only — no auth, no nav state.
 * Kept intentionally minimal so it can grow (account menu, nav links)
 * without touching page layouts.
 */
export function ProblemRadarHeader() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/80 bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60">
      <div className="mx-auto flex h-16 w-full max-w-[1040px] items-center justify-between px-6">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Radar className="size-5" />
          </span>
          <span className="text-base font-semibold tracking-tight">
            ProblemRadar
          </span>
        </Link>

        <span className="hidden text-sm text-muted-foreground sm:inline">
          Evidence-backed problem discovery
        </span>
      </div>
    </header>
  );
}
