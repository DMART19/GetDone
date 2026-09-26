"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { IntegrationProviderDefinition } from "@/lib/integrations/management";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message?: string };
}

export function IntegrationAddForm() {
  const router = useRouter();
  const [providers, setProviders] = useState<readonly IntegrationProviderDefinition[]>([]);
  const [providerId, setProviderId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [credentialBindingId, setCredentialBindingId] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [status, setStatus] = useState("Loading provider catalog…");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/control/integrations/providers", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as Envelope<IntegrationProviderDefinition[]>;
        if (!response.ok || !body.ok || !body.data) {
          throw new Error(body.error?.message ?? "Provider catalog unavailable");
        }
        setProviders(body.data);
        const first = body.data[0];
        if (first) {
          setProviderId(first.id);
          setDisplayName(first.displayName);
          setCapabilities(first.capabilities.slice(0, 1));
        }
        setStatus("");
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : "Provider catalog unavailable");
      });
  }, []);

  const provider = useMemo(
    () => providers.find((item) => item.id === providerId),
    [providers, providerId]
  );

  function changeProvider(value: string) {
    setProviderId(value);
    const next = providers.find((item) => item.id === value);
    if (next) {
      setDisplayName(next.displayName);
      setCapabilities(next.capabilities.slice(0, 1));
    }
  }

  function toggleCapability(capability: string) {
    setCapabilities((current) =>
      current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability]
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider || !displayName.trim() || capabilities.length === 0 || saving) return;
    setSaving(true);
    setStatus("Saving configuration…");
    try {
      const id = `${provider.id}:${crypto.randomUUID()}`;
      const response = await fetch("/api/control/integrations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID()
        },
        body: JSON.stringify({
          id,
          providerId: provider.id,
          displayName: displayName.trim(),
          credentialBindingId: credentialBindingId.trim() || undefined,
          capabilityNames: capabilities
        })
      });
      const body = await response.json() as Envelope<{ id: string }>;
      if (!response.ok || !body.ok || !body.data) {
        throw new Error(body.error?.message ?? "Integration configuration failed");
      }
      router.push(`/integrations/${encodeURIComponent(body.data.id)}`);
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Integration configuration failed");
      setSaving(false);
    }
  }

  return (
    <form className="integration-form" onSubmit={submit}>
      {status ? <div className="inline-note" role="status">{status}</div> : null}

      <label>
        <span>Provider</span>
        <select value={providerId} onChange={(event) => changeProvider(event.target.value)}>
          {providers.map((item) => (
            <option key={item.id} value={item.id}>{item.displayName}</option>
          ))}
        </select>
      </label>

      <label>
        <span>Display name</span>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={160}
          required
        />
      </label>

      <label>
        <span>Credential binding reference</span>
        <input
          value={credentialBindingId}
          onChange={(event) => setCredentialBindingId(event.target.value)}
          placeholder="e.g. binding-calendar-production"
          autoComplete="off"
        />
        <small>Reference only. Never paste an API key, token, password, or OAuth secret here.</small>
      </label>

      <fieldset>
        <legend>Capabilities</legend>
        <div className="integration-capability-list">
          {(provider?.capabilities ?? []).map((capability) => (
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

      <div className="integration-scope-note">
        <strong>Scope binding is server-authoritative</strong>
        <small>Company and environment come from your authenticated GetDone session and cannot be edited in this form.</small>
      </div>

      <button type="submit" className="primary-action" disabled={saving || capabilities.length === 0}>
        {saving ? "Saving…" : "Add integration"}
      </button>
    </form>
  );
}
