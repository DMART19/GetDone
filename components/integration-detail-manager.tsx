"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  IntegrationProviderDefinition,
  ManagedIntegrationConfiguration
} from "@/lib/integrations/management";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message?: string };
}

export function IntegrationDetailManager({ id }: { id: string }) {
  const [record, setRecord] = useState<ManagedIntegrationConfiguration | null>(null);
  const [providers, setProviders] = useState<readonly IntegrationProviderDefinition[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [credentialBindingId, setCredentialBindingId] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [status, setStatus] = useState("Loading integration…");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [recordResponse, providerResponse] = await Promise.all([
      fetch(`/api/control/integrations/${encodeURIComponent(id)}`, { cache: "no-store" }),
      fetch("/api/control/integrations/providers", { cache: "no-store" })
    ]);
    const recordBody = await recordResponse.json() as Envelope<ManagedIntegrationConfiguration>;
    const providerBody = await providerResponse.json() as Envelope<IntegrationProviderDefinition[]>;
    if (!recordResponse.ok || !recordBody.ok || !recordBody.data) {
      throw new Error(recordBody.error?.message ?? "Integration was not found");
    }
    if (!providerResponse.ok || !providerBody.ok || !providerBody.data) {
      throw new Error(providerBody.error?.message ?? "Provider catalog unavailable");
    }
    setRecord(recordBody.data);
    setProviders(providerBody.data);
    setDisplayName(recordBody.data.displayName);
    setCredentialBindingId(recordBody.data.credentialBindingId ?? "");
    setCapabilities([...recordBody.data.capabilityNames]);
    setStatus("");
  }

  useEffect(() => {
    load().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Integration is unavailable");
    });
  }, [id]);

  const provider = useMemo(
    () => providers.find((item) => item.id === record?.providerId),
    [providers, record?.providerId]
  );

  function toggleCapability(capability: string) {
    setCapabilities((current) =>
      current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability]
    );
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!record || busy || capabilities.length === 0) return;
    setBusy(true);
    setStatus("Saving changes…");
    try {
      const response = await fetch(`/api/control/integrations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID()
        },
        body: JSON.stringify({
          displayName: displayName.trim(),
          credentialBindingId: credentialBindingId.trim() || null,
          capabilityNames: capabilities
        })
      });
      const body = await response.json() as Envelope<ManagedIntegrationConfiguration>;
      if (!response.ok || !body.ok || !body.data) {
        throw new Error(body.error?.message ?? "Integration update failed");
      }
      setRecord(body.data);
      setStatus("Configuration saved. Health remains unverified until server-side verification succeeds.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Integration update failed");
    } finally {
      setBusy(false);
    }
  }

  async function control(action: "disable" | "revoke") {
    if (!record || busy) return;
    setBusy(true);
    setStatus(action === "revoke" ? "Revoking integration…" : "Disabling integration…");
    try {
      const response = await fetch(
        `/api/control/integrations/${encodeURIComponent(id)}/actions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID()
          },
          body: JSON.stringify({ action })
        }
      );
      const body = await response.json() as Envelope<ManagedIntegrationConfiguration>;
      if (!response.ok || !body.ok || !body.data) {
        throw new Error(
          body.error?.message
          ?? (action === "revoke"
            ? "Revocation requires owner role and fresh passkey step-up."
            : "Integration control failed")
        );
      }
      setRecord(body.data);
      setStatus(action === "revoke" ? "Integration revoked." : "Integration disabled.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Integration control failed");
    } finally {
      setBusy(false);
    }
  }

  if (!record) {
    return <div className="empty-state" role="status">{status}</div>;
  }

  return (
    <div className="integration-detail">
      <section className="integration-detail-card">
        <span>Provider</span>
        <strong>{provider?.displayName ?? record.providerId}</strong>
        <small>{record.adapterId} · v{record.adapterVersion}</small>
      </section>

      <div className="integration-facts">
        <div><span>Company</span><strong>{record.companyId}</strong></div>
        <div><span>Environment</span><strong>{record.environment}</strong></div>
        <div><span>State</span><strong>{record.state}</strong></div>
        <div><span>Health</span><strong>{record.health}</strong></div>
        <div>
          <span>Granted scopes</span>
          <strong>{record.grantedScopes.length ? record.grantedScopes.join(", ") : "Not verified"}</strong>
        </div>
        <div>
          <span>Last verification</span>
          <strong>{record.lastVerifiedAt ?? "Never"}</strong>
        </div>
      </div>

      <form className="integration-form" onSubmit={save}>
        <label>
          <span>Display name</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label>
          <span>Credential binding reference</span>
          <input
            value={credentialBindingId}
            onChange={(event) => setCredentialBindingId(event.target.value)}
            autoComplete="off"
          />
          <small>Broker reference only—raw credentials are rejected by the API.</small>
        </label>
        <fieldset>
          <legend>Capabilities</legend>
          <div className="integration-capability-list">
            {(provider?.capabilities ?? record.capabilityNames).map((capability) => (
              <label key={capability} className="integration-capability-option">
                <input
                  type="checkbox"
                  checked={capabilities.includes(capability)}
                  onChange={() => toggleCapability(capability)}
                />
                <span>{capability}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" className="primary-action" disabled={busy || capabilities.length === 0}>
          Save configuration
        </button>
      </form>

      <div className="integration-control-actions">
        <button
          type="button"
          className="secondary-action"
          disabled={busy || record.state === "disabled" || record.state === "revoked"}
          onClick={() => control("disable")}
        >
          Disable
        </button>
        <button
          type="button"
          className="danger-action"
          disabled={busy || record.state === "revoked"}
          onClick={() => control("revoke")}
        >
          Revoke
        </button>
      </div>
      {status ? <div className="inline-note" role="status">{status}</div> : null}
    </div>
  );
}
