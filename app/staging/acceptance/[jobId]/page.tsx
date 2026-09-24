import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { getControlApiAdapter } from "@/lib/control-api/runtime.server";
import { readAcceptanceResult } from "@/lib/staging/browser-acceptance.server";

export const dynamic = "force-dynamic";

export default async function StagingAcceptanceResultPage({
  params
}: {
  params: Promise<{ jobId: string }>;
}) {
  if (
    process.env.GETDONE_RUNTIME_ENV !== "staging"
    || process.env.GETDONE_STAGING_BROWSER_E2E !== "true"
  ) {
    notFound();
  }

  const incoming = await headers();
  const forwarded = new Headers();
  incoming.forEach((value, key) => forwarded.set(key, value));
  const principal = await getControlApiAdapter().authenticate(
    new Request("http://localhost/staging/acceptance", { headers: forwarded })
  );
  if (principal.role !== "owner") notFound();

  const { jobId } = await params;
  const result = await readAcceptanceResult(principal.scope, jobId);

  return (
    <AppShell navigation={false}>
      <BackHeader title="Staging acceptance" href="/" />
      <section className="page-content">
        <h1>Authoritative completion</h1>
        <p className="lead">
          {result.authoritativeCompletion
            ? "Verified from persisted Job, provider, verification, and durable outcome evidence."
            : "Completion evidence is incomplete."}
        </p>
        <article className="detail-card">
          <span>Execution</span>
          <p data-testid="acceptance-job-id">{result.jobId}</p>
          <p data-testid="acceptance-correlation-id">{result.correlationId}</p>
        </article>
        <article className="detail-card">
          <span>Durable runtime</span>
          <p data-testid="acceptance-runtime-state">{result.runtimeState ?? "missing"}</p>
          <p data-testid="acceptance-outcome">{result.durableOutcome ?? "missing"}</p>
        </article>
        <article className="detail-card">
          <span>Provider verification</span>
          <p data-testid="acceptance-provider-state">{result.providerState ?? "missing"}</p>
          <p data-testid="acceptance-verification-result">{result.verificationResult ?? "missing"}</p>
          <p data-testid="acceptance-evidence-id">{result.verificationEvidenceId ?? "missing"}</p>
        </article>
        <div role="status" data-testid="authoritative-completion">
          {result.authoritativeCompletion ? "Authoritative completion verified" : "Not verified"}
        </div>
      </section>
    </AppShell>
  );
}
