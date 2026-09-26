import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DevelopmentBadge } from "@/components/dev-badge";
import { IntegrationDetailManager } from "@/components/integration-detail-manager";

export default async function IntegrationDetailPage(
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return (
    <AppShell navigation={false}>
      <BackHeader title="Integration" href="/integrations" rightLabel="Done" rightHref="/integrations" />
      <DevelopmentBadge />
      <section className="page-content">
        <IntegrationDetailManager id={id} />
      </section>
    </AppShell>
  );
}
