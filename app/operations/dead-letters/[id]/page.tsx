import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DeadLetterDetail } from "@/components/dead-letter-detail";
import { DevelopmentBadge } from "@/components/dev-badge";

export const dynamic = "force-dynamic";

export default async function DeadLetterDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <AppShell navigation={false}>
      <BackHeader title="Dead-letter Job" href="/operations/dead-letters" />
      <DevelopmentBadge />
      <section className="page-content">
        <DeadLetterDetail jobId={id} />
      </section>
    </AppShell>
  );
}
