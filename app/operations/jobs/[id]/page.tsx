import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import type { ApiEnvelope } from "@/lib/control-plane/schemas";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { JobResultView } from "@/lib/control-api/contracts";

export const dynamic = "force-dynamic";

async function controlGet<T>(path: string): Promise<T> {
  const incoming = await headers();
  const outgoing = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "authorization", "x-getdone-portfolio-id"]) {
    const value = incoming.get(name);
    if (value) outgoing.set(name, value);
  }
  const configured = process.env.GETDONE_CONTROL_API_URL?.trim();
  const base = configured
    ? configured.endsWith("/") ? configured : configured + "/"
    : `${incoming.get("x-forwarded-proto") ?? "https"}://${incoming.get("host")}/`;

  const response = await fetch(new URL(path, base), {
    method: "GET",
    cache: "no-store",
    headers: outgoing
  });
  const value = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (response.status === 401) redirect("/sign-in");
  if (response.status === 404) notFound();
  if (!response.ok || !value?.ok) {
    throw new Error(value?.error?.message ?? "Authoritative Job read failed");
  }
  return value.data;
}

export default async function JobResultPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [job, result] = await Promise.all([
    controlGet<JobRecord>(`/api/control/jobs/${encodeURIComponent(id)}`),
    controlGet<JobResultView>(`/api/control/jobs/${encodeURIComponent(id)}/result`)
  ]);

  return (
    <AppShell navigation={false}>
      <BackHeader title="Job result" href="/operations" />
      <section className="page-content">
        <div className="title-row">
          <div>
            <h1>Authoritative completion</h1>
            <p>Persisted control-plane truth for this Job.</p>
          </div>
        </div>
        <article className="detail-card">
          <span>Job</span>
          <p><strong>{job.id}</strong></p>
        </article>
        <article className="detail-card">
          <span>Status</span>
          <p role="status"><strong>{result.state}</strong></p>
        </article>
        <article className="detail-card">
          <span>Verification</span>
          <p>
            {result.verificationReceiptId
              ? `Verified · ${result.verificationEvidenceIds.length} evidence item(s)`
              : "No authoritative verification receipt"}
          </p>
        </article>
        <article className="detail-card">
          <span>Correlation ID</span>
          <p data-testid="job-correlation-id">{result.correlationId ?? "Unavailable"}</p>
        </article>
      </section>
    </AppShell>
  );
}
