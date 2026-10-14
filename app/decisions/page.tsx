import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { DecisionSpotlight } from "@/components/decision-spotlight";
import { DavidDecisionDesk } from "@/components/david-decision-desk";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function DecisionsPage() {
  const repository = await getOwnerReadRepository();
  const decisions = await repository.listDecisions();
  const records = [...decisions];
  const attention = records.filter(d => d.priority !== "fyi" && d.status === "pending").length;
  return <AppShell>
    {process.env.GETDONE_DAVID_EDITION === "true" ? <DavidDecisionDesk decisions={records} /> : <>
      <AppHeader />
      <section className="ufo-page ufo-decisions-page">
        <div className="ufo-page-title"><h1>Decision Center {attention > 0 ? <span>{attention}</span> : null}</h1><p>Only what needs your attention.</p></div>
        <DecisionSpotlight decisions={records} />
      </section>
    </>}
  </AppShell>;
}
