import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BusinessSystem } from "@/components/business-system";
import { getBusinessCatalog, isBusinessPreview } from "@/lib/businesses/runtime.server";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { AppShell } from "@/components/app-shell";
import { HomeDashboard } from "@/components/home-dashboard";
import { ChatComposer } from "@/components/chat-composer";
import type { Business } from "@/lib/businesses/contracts";
import { OwnerAttentionRadar } from "@/components/owner-attention-radar";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let singleBusiness = isBusinessPreview();
  let catalogUnavailable = false;
  let businessCount = 0;
  let authorizedBusinesses: Business[] = [];
  let ownerBusinesses: Business[] = [];
  try {
    const businesses = await getBusinessCatalog(new Request("http://getdone.internal/", { headers: await headers() }));
    authorizedBusinesses = businesses;
    ownerBusinesses = businesses.filter(business => business.role === "owner");
    businessCount = businesses.length;
    singleBusiness ||= businessCount === 1;
  } catch (error) {
    if (error instanceof ControlPlaneError && error.code === "UNAUTHENTICATED") redirect("/sign-in");
    catalogUnavailable = true;
  }
  const repository = await getOwnerReadRepository();
  const objectives = singleBusiness && !catalogUnavailable ? await repository.listObjectives() : null;
  const decisions = process.env.GETDONE_DAVID_EDITION === "true" && objectives
    ? await repository.listDecisions()
    : null;

  return (
    <AppShell className="business-home">
      {process.env.GETDONE_DAVID_EDITION === "true" ? <div className="de-caption">✦ DAVID EDITION / OWNER 01 / UNIVERSE COMMAND</div> : null}
      <BusinessSystem cinematic={process.env.GETDONE_DAVID_EDITION === "true"} />
      {objectives && decisions ? <OwnerAttentionRadar objectives={objectives} decisions={decisions} /> : null}
      {objectives ? <HomeDashboard objectives={[...objectives]} portfolioId={authorizedBusinesses[0]?.portfolioId} /> : businessCount > 1 ? (
        <section className="ufo-command-card" aria-label="Multi-business conversation"><h2>Ask GetDone about a business</h2><p>Select an authorized planet. Each conversation is securely scoped to that business.</p>{ownerBusinesses.length ? <ChatComposer businesses={ownerBusinesses} /> : <p>No owner-authorized portfolio is available for conversation. Contact your administrator to confirm your role.</p>}</section>
      ) : null}
    </AppShell>
  );
}
