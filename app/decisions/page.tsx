import { DavidEditionDecisionCommand } from "@/components/david-edition-decisions";
import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { DecisionSpotlight } from "@/components/decision-spotlight";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function DecisionsPage() {
  const repository = await getOwnerReadRepository();
  const decisions = await repository.listDecisions();
  const attention = decisions.filter(
    (decision) => decision.priority !== "fyi" && decision.status === "pending"
  ).length;

  return (
    <AppShell>
      {process.env.GETDONE_DAVID_EDITION !== "true" ? <AppHeader /> : null}
      {process.env.GETDONE_DAVID_EDITION === "true" ? <DavidEditionDecisionCommand decisions={[...decisions]} /> : <section className="ufo-page ufo-decisions-page">
        <div className="ufo-page-title">
          <h1>Decision Center {attention > 0 ? <span>{attention}</span> : null}</h1>
          <p>Only what needs your attention.</p>
        </div>
        <DecisionSpotlight decisions={[...decisions]} />
      </section>}
    </AppShell>
  );
}
