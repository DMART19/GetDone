import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DevelopmentBadge } from "@/components/dev-badge";
import { AddResourceChoices } from "@/components/add-resource-choices";

export default function AddResourcePage() {
  return (
    <AppShell navigation={false}>
      <BackHeader title="Add Resource" href="/resources" rightLabel="Cancel" rightHref="/resources" />
      <DevelopmentBadge />
      <section className="page-content add-resource-page">
        <h2>Connect a governed resource</h2>
        <p>GitHub is available for the initial release. Other resource types are clearly deferred.</p>
        <AddResourceChoices />
      </section>
    </AppShell>
  );
}
