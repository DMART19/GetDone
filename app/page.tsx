import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BusinessSystem } from "@/components/business-system";
import { getBusinessCatalog, isBusinessPreview } from "@/lib/businesses/runtime.server";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { HomeDashboard } from "@/components/home-dashboard";
import { ChatComposer } from "@/components/chat-composer";
import { OwnerAttentionRadar } from "@/components/owner-attention-radar";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let singleBusiness = isBusinessPreview();
  let catalogUnavailable = false;
  let businessCount = 0;
  try {
    const businesses = await getBusinessCatalog(new Request("http://getdone.internal/", { headers: await headers() }));
    businessCount = businesses.length;
    singleBusiness ||= businessCount === 1;
  } catch (error) {
    if (error instanceof ControlPlaneError && error.code === "UNAUTHENTICATED") redirect("/sign-in");
    catalogUnavailable = true;
  }
  const repository = await getOwnerReadRepository();
  const objectives = singleBusiness && !catalogUnavailable ? await repository.listObjectives() : null;
  const decisions = process.env.GETDONE_DAVID_EDITION === "true" && objectives ? await repository.listDecisions() : null;

  return (
    <AppShell className="business-home">
      <AppHeader />
      <BusinessSystem cinematic={process.env.GETDONE_DAVID_EDITION === "true"} />
      {objectives && decisions ? <OwnerAttentionRadar objectives={objectives} decisions={decisions} /> : null}
      {objectives ? <HomeDashboard objectives={[...objectives]} /> : businessCount > 1 ? (
        <section className="ufo-command-card" aria-label="Business conversation"><h2>Ask GetDone about your businesses</h2><ChatComposer /></section>
      ) : null}
    </AppShell>
  );
}
