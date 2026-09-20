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
        <h2>What would you like to add?</h2>
        <p>Same simple flow for a Raspberry Pi or a data-center. GetDone will guide you.</p>
        <AddResourceChoices />
      </section>
    </AppShell>
  );
}
