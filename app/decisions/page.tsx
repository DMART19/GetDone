import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { DecisionFilters } from "@/components/decision-filters";
import { DevelopmentBadge } from "@/components/dev-badge";
import { decisions } from "@/lib/mock-data";

export default function DecisionsPage() {
  const pending = decisions.filter((decision) => decision.status === "pending").length;
  return (
    <AppShell>
      <AppHeader />
      <DevelopmentBadge />
      <section className="page-content">
        <div className="title-row"><div><h1>Decisions <span className="decision-count">{pending}</span></h1><p>Your input keeps everything moving.</p></div></div>
        <DecisionFilters decisions={decisions} />
      </section>
    </AppShell>
  );
}
