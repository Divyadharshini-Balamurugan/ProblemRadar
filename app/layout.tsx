import type { Metadata } from "next";
import { ProblemRadarHeader } from "@/components/problem-radar-header";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProblemRadar — Discover real problems worth solving",
  description:
    "ProblemRadar helps builders and founders discover real, evidence-backed problems people are facing before writing a single line of code.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ProblemRadarHeader />
        <main className="flex flex-1 flex-col">{children}</main>
      </body>
    </html>
  );
}
