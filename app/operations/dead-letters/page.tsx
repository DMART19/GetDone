import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DeadLetterList } from "@/components/dead-letter-list";
import { DevelopmentBadge } from "@/components/dev-badge";

export const dynamic = "force-dynamic";

export default function DeadLettersPage() {
  return (
    <AppShell navigation={false}>
      <BackHeader title="Dead-letter Jobs" href="/resources" />
      <DevelopmentBadge />
      <section className="page-content">
        <div className="title-row">
          <div>
            <h1>Operator Review</h1>
            <p>Inspect terminal failure lineage before deciding what happens next.</p>
          </div>
        </div>
        <DeadLetterList />
      </section>
    </AppShell>
  );
}
