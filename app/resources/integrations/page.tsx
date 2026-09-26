import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DevelopmentBadge } from "@/components/dev-badge";
import { IntegrationManager } from "@/components/integration-manager";

export default function IntegrationsPage(){
  return (
    <AppShell navigation={false}>
      <BackHeader title="Integrations" href="/resources" rightLabel="Resources" rightHref="/resources"/>
      <DevelopmentBadge/>
      <section className="page-content integrations-page">
        <div className="title-row">
          <div>
            <h1>Integrations</h1>
            <p>Governed provider connections for this company and environment.</p>
          </div>
        </div>
        <IntegrationManager/>
      </section>
    </AppShell>
  );
}
