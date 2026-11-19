"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Cloud, Database, Github, Network, Server, Shapes, Warehouse } from "lucide-react";

type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string } };

const deferred = [
  { title: "Compute", detail: "Server, GPU, Raspberry Pi, VM, cluster", icon: Server },
  { title: "Storage", detail: "NAS, cloud storage, backup, archive", icon: Database },
  { title: "Network", detail: "VPN, gateway, private link", icon: Network },
  { title: "Cloud Provider", detail: "AWS, Google Cloud, Azure", icon: Cloud },
  { title: "Data Center / Partner", detail: "Partner cluster or colocation", icon: Warehouse },
  { title: "Other", detail: "Custom governed resource", icon: Shapes }
] as const;

function errorMessage(response: Response, body: Envelope<unknown>) {
  if (response.status === 401) return "Your owner session expired. Sign in again and retry.";
  if (response.status === 403) return body.error?.message ?? "Your role cannot enroll this repository.";
  if (response.status === 409) return body.error?.message ?? "This repository has a conflicting enrollment.";
  if (response.status === 429) return "Too many enrollment attempts. Wait briefly and retry.";
  return body.error?.message ?? "GitHub enrollment could not be completed. Retry or review the connection.";
}

export function AddResourceChoices() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function enrollGithub(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setStatus("Verifying the GitHub App and repository permissions…");
    try {
      const response = await fetch("/api/control/resources/github/enroll", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          repository: "DMART19/GetDone",
          environment: "production",
          protectedBranches: ["main"]
        })
      });
      const body = await response.json().catch(() => ({ ok: false })) as Envelope<{ id: string }>;
      if (!response.ok || !body.ok || !body.data?.id) throw new Error(errorMessage(response, body));
      setStatus(`GitHub repository enrolled. Resource ID: ${body.data.id}`);
      router.push(`/resources/${encodeURIComponent(body.data.id)}`);
      router.refresh();
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "GitHub enrollment failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="github-enrollment-card" onSubmit={enrollGithub}>
        <div className="choice-row github-choice-row">
          <span className="choice-icon"><Github size={24} /></span>
          <span><strong>GitHub repository</strong><small>Connect the initial governed repository</small></span>
        </div>
        <label>Repository<input value="DMART19/GetDone" readOnly aria-readonly="true" /></label>
        <label>
          Environment
          <select value="production" disabled aria-label="Environment">
            <option value="production">Production</option>
          </select>
        </label>
        <label>Protected branches<input value="main" readOnly aria-readonly="true" /></label>
        <p className="connection-note">
          Uses the existing GetDone GitHub App and credential broker. The server verifies the
          repository and permissions before persisting the resource.
        </p>
        <button type="submit" className="primary-action" disabled={busy}>
          {busy ? "Verifying GitHub…" : "Enroll GitHub repository"}
          {!busy ? <ArrowRight size={18} /> : null}
        </button>
      </form>

      {status ? (
        <div className={failed ? "inline-note inline-note-error" : "inline-note"} role="status">
          {status}
          {failed ? <button type="button" onClick={() => setStatus(null)}>Dismiss</button> : null}
        </div>
      ) : null}

      <section className="deferred-resources" aria-labelledby="deferred-resources-heading">
        <h3 id="deferred-resources-heading">Coming later</h3>
        <p>These resource types will open after their governed enrollment workflows exist.</p>
        <div className="choice-list">
          {deferred.map(({ title, detail, icon: Icon }) => (
            <button key={title} type="button" className="choice-row deferred-choice" disabled aria-disabled="true">
              <span className="choice-icon"><Icon size={24} /></span>
              <span><strong>{title}</strong><small>{detail}</small></span>
              <em>Coming soon</em>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
