import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BusinessSystem } from "@/components/business-system";
import { getBusinessCatalog, isBusinessPreview } from "@/lib/businesses/runtime.server";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { AppShell } from "@/components/app-shell";
import { HomeDashboard } from "@/components/home-dashboard";
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

  return (
    <AppShell className="business-home">
      {process.env.GETDONE_DAVID_EDITION === "true" ? <div className="de-caption">✦ DAVID EDITION / OWNER 01 / UNIVERSE COMMAND</div> : null}
      <BusinessSystem cinematic={process.env.GETDONE_DAVID_EDITION === "true"} />
      {objectives ? <HomeDashboard objectives={[...objectives]} /> : businessCount > 1 ? (
        <p className="business-scope-note">Select a business to inspect its work. Objective submission and chat currently require an account with one active business.</p>
      ) : null}
    </AppShell>
  );
}
