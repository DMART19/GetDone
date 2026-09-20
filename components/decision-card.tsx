import Link from "next/link";
import { BarChart3, Bug, ChevronRight, Megaphone, Server, Users } from "lucide-react";
import { PriorityPill } from "@/components/status";
import type { Decision } from "@/lib/types";

const icons = {
  resource: Server,
  growth: BarChart3,
  incident: Bug,
  budget: Megaphone,
  outreach: Users
} as const;

export function DecisionCard({ decision }: { decision: Decision }) {
  const Icon = icons[decision.category];
  return (
    <Link href={`/decisions/${decision.id}`} className={`decision-card decision-${decision.priority}`}>
      <span className="decision-icon"><Icon size={24} /></span>
      <span className="decision-copy">
        <strong>{decision.title}</strong>
        <small>{decision.subtitle}</small>
        <span className="decision-meta"><PriorityPill priority={decision.priority} /><span>{decision.age}</span></span>
      </span>
      <ChevronRight size={20} className="row-chevron" />
    </Link>
  );
}
