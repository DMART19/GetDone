import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DevelopmentBadge } from "@/components/dev-badge";
import { IntegrationAddForm } from "@/components/integration-add-form";

export default function AddIntegrationPage() {
  return (
    <AppShell navigation={false}>
      <BackHeader title="Add Integration" href="/integrations" rightLabel="Cancel" rightHref="/integrations" />
      <DevelopmentBadge />
      <section className="page-content add-resource-page">
        <h2>Connect a provider safely</h2>
        <p>Select approved capabilities and a credential-binding reference. Raw credential material is never accepted here.</p>
        <IntegrationAddForm />
      </section>
    </AppShell>
  );
}
