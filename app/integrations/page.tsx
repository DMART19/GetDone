import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { DevelopmentBadge } from "@/components/dev-badge";
import { IntegrationManager } from "@/components/integration-manager";

export const dynamic = "force-dynamic";

export default function IntegrationsPage() {
  return (
    <AppShell>
      <AppHeader />
      <DevelopmentBadge />
      <section className="page-content">
        <div className="title-row">
          <div>
            <h1>Integrations</h1>
            <p>Provider connections, capabilities, scope, verification health and controls.</p>
          </div>
        </div>
        <IntegrationManager />
      </section>
    </AppShell>
  );
}
