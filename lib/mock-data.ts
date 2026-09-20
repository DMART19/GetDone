import type { Decision, Resource } from "./types";

export const resourceSummary = {
  health: "Healthy",
  resourceCount: 12,
  capacity: 68,
  monthlySpend: "$84,210",
  monthlyChange: "↓ 18%",
  ownedSavings: "$29,440"
} as const;

export const resources: Resource[] = [
  {
    id: "home-pi",
    name: "Home Pi",
    role: "Compute · Lightweight",
    kind: "compute",
    health: "online",
    provider: "Owned",
    location: "Home",
    environments: ["Development", "Staging"],
    customerDataPolicy: "No production customer data",
    reliabilityTier: "Best effort",
    autoScheduling: true,
    metrics: [
      { label: "CPU Available", value: "4 cores" },
      { label: "Memory Free", value: "6.1 GB", tone: "good" },
      { label: "Effective Cost", value: "$0.01/hr" }
    ],
    workloads: { running: 2, queued: 1, utilization: 41 },
    icon: "server"
  },
  {
    id: "home-gpu",
    name: "Home GPU",
    role: "Compute · AI/ML",
    kind: "compute",
    health: "online",
    provider: "Owned",
    location: "Home",
    environments: ["Development", "Staging"],
    customerDataPolicy: "Restricted",
    reliabilityTier: "Best effort",
    autoScheduling: true,
    metrics: [
      { label: "VRAM Available", value: "18 GB" },
      { label: "Utilization", value: "52%", tone: "good" },
      { label: "Effective Cost", value: "$0.07/hr" }
    ],
    workloads: { running: 3, queued: 2, utilization: 52 },
    icon: "gpu"
  },
  {
    id: "home-nas",
    name: "Home NAS",
    role: "Storage · Backup",
    kind: "storage",
    health: "healthy",
    provider: "Owned",
    location: "Home",
    environments: ["Development", "Staging"],
    customerDataPolicy: "Approved cache / backup only",
    reliabilityTier: "Secondary",
    autoScheduling: false,
    metrics: [
      { label: "Free Space", value: "3.2 TB", tone: "good" },
      { label: "Utilization", value: "68%" },
      { label: "Monthly Cost", value: "$18" }
    ],
    workloads: { running: 4, queued: 0, utilization: 68 },
    icon: "storage"
  },
  {
    id: "dc-west",
    name: "DC West",
    role: "Compute · GPU Pool",
    kind: "partner",
    health: "healthy",
    provider: "Partner Data Center",
    location: "US West",
    environments: ["Development", "Staging", "Production"],
    customerDataPolicy: "Allowed (restricted)",
    reliabilityTier: "High",
    autoScheduling: true,
    metrics: [
      { label: "GPUs Available", value: "1,248" },
      { label: "Utilization", value: "67%", tone: "good" },
      { label: "/ GPU hour", value: "$0.42" }
    ],
    workloads: { running: 12, queued: 48, utilization: 67 },
    icon: "server"
  },
  {
    id: "aws",
    name: "AWS",
    role: "Cloud · Multi",
    kind: "cloud",
    health: "healthy",
    provider: "AWS",
    location: "US multi-region",
    environments: ["Development", "Staging", "Production"],
    customerDataPolicy: "Policy-bound",
    reliabilityTier: "High",
    autoScheduling: true,
    metrics: [
      { label: "Regions Ready", value: "3" },
      { label: "Capacity", value: "Elastic", tone: "good" },
      { label: "Spend MTD", value: "$5.4k" }
    ],
    workloads: { running: 8, queued: 6, utilization: 38 },
    icon: "cloud"
  }
];

export const decisions: Decision[] = [
  {
    id: "approve-dc-west",
    title: "Approve resource addition",
    subtitle: "DC West compute pool",
    priority: "high",
    age: "2h ago",
    category: "resource",
    status: "pending",
    rationale: "The new partner pool passed the development preview checks and needs owner review before a future production enrollment workflow exists.",
    impact: ["Adds projected GPU capacity", "No production side effect in this build", "Real authorization is deferred"]
  },
  {
    id: "landing-page",
    title: "Deploy new landing page",
    subtitle: "+18% projected signups",
    priority: "high",
    age: "4h ago",
    category: "growth",
    status: "pending",
    rationale: "Seeded development decision used to demonstrate the unified approval queue.",
    impact: ["Preview-only recommendation", "Would require deployment verification later"]
  },
  {
    id: "production-error",
    title: "Production error fix",
    subtitle: "Error rate increased overnight",
    priority: "high",
    age: "6h ago",
    category: "incident",
    status: "pending",
    rationale: "Seed data representing a future incident-response approval.",
    impact: ["High attention", "No automatic production authority"]
  },
  {
    id: "ad-budget",
    title: "Increase ad budget",
    subtitle: "$50 → $100/day (test 7 days)",
    priority: "normal",
    age: "8h ago",
    category: "budget",
    status: "pending",
    rationale: "Seeded budget decision for UI testing.",
    impact: ["Would require budget policy checks in a later phase"]
  },
  {
    id: "prospects",
    title: "Add 2 prospects to outreach",
    subtitle: "High-fit warehouse leads",
    priority: "normal",
    age: "12h ago",
    category: "outreach",
    status: "pending",
    rationale: "Seeded outreach decision for UI testing.",
    impact: ["No email is sent in this phase"]
  },
  {
    id: "capacity-note",
    title: "Capacity trend recorded",
    subtitle: "Home GPU headroom remains healthy",
    priority: "fyi",
    age: "14h ago",
    category: "resource",
    status: "pending",
    rationale: "Seeded FYI item used to represent low-attention infrastructure context.",
    impact: ["Informational only", "No approval or action is required"]
  },
  {
    id: "growth-note",
    title: "Growth experiment summary",
    subtitle: "Landing-page signal retained for review",
    priority: "fyi",
    age: "1d ago",
    category: "growth",
    status: "pending",
    rationale: "Seeded FYI item used to round out the screenshot-style decision queue.",
    impact: ["Informational only"]
  }
];

export function getResource(id: string) {
  return resources.find((resource) => resource.id === id);
}

export function getDecision(id: string) {
  return decisions.find((decision) => decision.id === id);
}
