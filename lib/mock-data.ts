import type {
  ExplorationChip,
  Problem,
  QuickStartOption,
  ResearchStage,
} from "@/types";

/**
 * MOCK DATA ONLY.
 *
 * Everything in this file stands in for what will eventually come from
 * the real ProblemRadar research engine (intent parser → research planner
 * → SerpAPI → evidence analysis → problem detection). Nothing here calls
 * a network or a database. See docs/README.md for the planned data flow.
 */

export const QUICK_START_OPTIONS: QuickStartOption[] = [
  {
    id: "discover",
    title: "Discover Problems",
    description: "I don't know what to build yet",
    promptHint: "Show me real problems worth solving right now",
  },
  {
    id: "explore",
    title: "Explore an Area",
    description: "Find problems in an industry, audience, or location",
    promptHint: "Find problems in ",
  },
  {
    id: "investigate",
    title: "Investigate a Problem",
    description: "I already have a problem in mind",
    promptHint: "Validate whether this is a real, recurring problem: ",
  },
];

export const EXPLORATION_CHIPS: ExplorationChip[] = [
  {
    id: "chip-people",
    label: "People",
    category: "people",
    promptPrefix: "Find problems faced by ",
  },
  {
    id: "chip-industry",
    label: "Industry",
    category: "industry",
    promptPrefix: "Find problems in the industry: ",
  },
  {
    id: "chip-location",
    label: "Location",
    category: "location",
    promptPrefix: "Find problems specific to this location: ",
  },
];

export const RESEARCH_STAGES: ResearchStage[] = [
  {
    id: "understanding",
    title: "Understanding your request",
    description: "Parsing your query to identify intent, scope, and constraints.",
    status: "complete",
  },
  {
    id: "directions",
    title: "Generating research directions",
    description: "Planning the angles and questions worth investigating.",
    status: "complete",
  },
  {
    id: "searching",
    title: "Searching sources",
    description: "Sweeping forums, reviews, and communities for raw signal.",
    status: "active",
  },
  {
    id: "analyzing",
    title: "Analyzing recurring problems",
    description: "Clustering complaints and requests into recurring themes.",
    status: "pending",
  },
  {
    id: "validating",
    title: "Validating findings",
    description: "Cross-checking recurrence and evidence quality.",
    status: "pending",
  },
  {
    id: "building",
    title: "Building opportunities",
    description: "Shaping validated problems into concrete opportunities.",
    status: "pending",
  },
];

export const MOCK_PROBLEMS: Problem[] = [
  {
    id: "problem-1",
    title: "Freelancers can't track scattered client payments",
    description:
      "Independent contractors juggle invoices across email, WhatsApp, and bank apps, and routinely lose track of who still owes what — leading to late follow-ups and unpaid work.",
    recurrence: "high",
    recurrenceCount: 42,
    evidenceCount: 18,
    tags: ["Freelancing", "Payments", "SMB"],
    sources: [
      { id: "s1", label: "r/freelance — \"How do you track late payments?\"" },
      { id: "s2", label: "IndieHackers thread on invoicing pain points" },
      { id: "s3", label: "Twitter/X thread, 200+ replies" },
    ],
  },
  {
    id: "problem-2",
    title: "Small clinics lose patient follow-ups after discharge",
    description:
      "Pediatric and outpatient clinics rely on manual call-backs for follow-up care, and a large share of patients fall through the cracks between visits.",
    recurrence: "high",
    recurrenceCount: 35,
    evidenceCount: 14,
    tags: ["Healthcare", "SaaS", "Operations"],
    sources: [
      { id: "s1", label: "Clinic operations forum post" },
      { id: "s2", label: "Reddit r/medicalpractice discussion" },
    ],
  },
  {
    id: "problem-3",
    title: "Rice mill owners can't reconcile government CMR quotas",
    description:
      "Custom-milling operators track paddy intake and rice output for government schemes on paper or spreadsheets, causing quota mismatches at audit time.",
    recurrence: "medium",
    recurrenceCount: 19,
    evidenceCount: 9,
    tags: ["Agritech", "Government", "India"],
    sources: [
      { id: "s1", label: "Regional trade association bulletin" },
      { id: "s2", label: "Interview notes from mill owners" },
    ],
  },
  {
    id: "problem-4",
    title: "Parents can't find vetted after-school activity providers",
    description:
      "Parents rely on word-of-mouth and scattered WhatsApp groups to vet coaches and centers, with no central place to compare pricing, safety, or reviews.",
    recurrence: "medium",
    recurrenceCount: 16,
    evidenceCount: 7,
    tags: ["Parenting", "Marketplace", "Local"],
    sources: [{ id: "s1", label: "Local parenting Facebook group thread" }],
  },
  {
    id: "problem-5",
    title: "Early-stage founders overpay for tools they barely use",
    description:
      "Founders stack SaaS subscriptions during early growth and rarely audit usage, leading to recurring spend on tools that overlap or sit idle.",
    recurrence: "low",
    recurrenceCount: 8,
    evidenceCount: 5,
    tags: ["SaaS", "FinOps", "Startups"],
    sources: [{ id: "s1", label: "IndieHackers cost-cutting thread" }],
  },
  {
    id: "problem-6",
    title: "Neighborhood clinics struggle with multi-branch scheduling",
    description:
      "Practices operating more than one branch coordinate staff and room availability by phone, causing double-bookings during peak hours.",
    recurrence: "medium",
    recurrenceCount: 13,
    evidenceCount: 6,
    tags: ["Healthcare", "Ops Tooling"],
    sources: [{ id: "s1", label: "Practice management forum thread" }],
  },
];
