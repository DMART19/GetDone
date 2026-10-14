import { AppShell } from "@/components/app-shell";
import { DavidDecisionDesk } from "@/components/david-decision-desk";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function DecisionsPage() {
  const repository = await getOwnerReadRepository();
  const decisions = await repository.listDecisions();
  return (
    <AppShell>
      <DavidDecisionDesk decisions={[...decisions]} />
    </AppShell>
  );
}
