import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DecisionActions } from "@/components/decision-actions";
import { DevelopmentBadge } from "@/components/dev-badge";
import { PriorityPill } from "@/components/status";
import { developmentOwnerRepository } from "@/lib/data/repository";

export async function generateStaticParams() {
  const decisions = await developmentOwnerRepository.listDecisions();
  return decisions.map((decision) => ({ id: decision.id }));
}

export default async function DecisionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const decision = await developmentOwnerRepository.getDecision(id);
  if (!decision) notFound();

  return (
    <AppShell navigation={false}>
      <BackHeader title="Decision" href="/decisions" />
      <DevelopmentBadge />
      <section className="page-content decision-detail-page">
        <div className="decision-detail-heading"><PriorityPill priority={decision.priority} /><span>{decision.age}</span></div>
        <h1>{decision.title}</h1>
        <p className="lead">{decision.subtitle}</p>
        <article className="detail-card"><span>Why this is here</span><p>{decision.rationale}</p></article>
        <article className="detail-card"><span>Expected impact</span><ul>{decision.impact.map((item) => <li key={item}>{item}</li>)}</ul></article>
        <DecisionActions />
      </section>
    </AppShell>
  );
}
