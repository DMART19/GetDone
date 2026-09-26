"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Plus, PlugZap, ShieldCheck } from "lucide-react";
import type { ManagedIntegrationConfiguration } from "@/lib/integrations/management";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { message?: string };
}

function healthClass(health: ManagedIntegrationConfiguration["health"]) {
  if (health === "healthy") return "integration-health integration-health-good";
  if (health === "degraded" || health === "unavailable") return "integration-health integration-health-warn";
  if (health === "revoked") return "integration-health integration-health-revoked";
  return "integration-health";
}

export function IntegrationManager() {
  const [records, setRecords] = useState<readonly ManagedIntegrationConfiguration[]>([]);
  const [status, setStatus] = useState("Loading authoritative integration state…");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/control/integrations", {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" }
    })
      .then(async (response) => {
        const body = await response.json() as Envelope<ManagedIntegrationConfiguration[]>;
        if (!response.ok || !body.ok || !body.data) {
          throw new Error(body.error?.message ?? "Integration management is unavailable");
        }
        if (!active) return;
        setRecords(body.data);
        setStatus(body.data.length ? "" : "No integrations configured in this company/environment.");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFailed(true);
        setStatus(error instanceof Error ? error.message : "Integration management is unavailable");
      });
    return () => { active = false; };
  }, []);

  return (
    <>
      <div className="integration-toolbar">
        <div>
          <strong>Authoritative connections</strong>
          <small>Credentials stay behind the broker. This surface stores references only.</small>
        </div>
        <Link href="/integrations/add" className="primary-action integration-add">
          <Plus size={16} /> Add
        </Link>
      </div>

      {status ? (
        <div className={failed ? "dead-letter-error" : "empty-state"} role="status">
          {status}
        </div>
      ) : null}

      <div className="integration-list">
        {records.map((record) => (
          <Link
            key={record.id}
            href={`/integrations/${encodeURIComponent(record.id)}`}
            className="integration-row"
          >
            <span className="integration-provider-icon">
              {record.health === "healthy" ? <ShieldCheck size={19} /> : <PlugZap size={19} />}
            </span>
            <span className="integration-copy">
              <strong>{record.displayName}</strong>
              <small>{record.providerId} · {record.companyId} · {record.environment}</small>
              <span>
                {record.capabilityNames.length} capabilities · {record.grantedScopes.length
                  ? `${record.grantedScopes.length} granted scopes`
                  : "Scopes not verified"}
              </span>
            </span>
            <span className={healthClass(record.health)}>{record.health}</span>
            <ArrowRight size={17} className="row-chevron" />
          </Link>
        ))}
      </div>
    </>
  );
}
