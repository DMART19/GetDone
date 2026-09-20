import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { DecisionFilters } from "@/components/decision-filters";
import { DevelopmentBadge } from "@/components/dev-badge";
import { developmentOwnerRepository } from "@/lib/data/repository";

export default async function DecisionsPage() {
  const decisions = await developmentOwnerRepository.listDecisions();
  const attention = decisions.filter((decision) => decision.priority === "high" && decision.status === "pending").length;

  return (
    <AppShell>
      <AppHeader />
      <DevelopmentBadge />
      <section className="page-content">
        <div className="title-row">
          <div>
            <h1>Decisions <span className="decision-count">{attention}</span></h1>
            <p>Your input keeps everything moving.</p>
          </div>
        </div>
        <DecisionFilters decisions={[...decisions]} />
      </section>
    </AppShell>
  );
}
