"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DeadLetterOperatorActionResult,
  DeadLetterOperatorView
} from "@/lib/execution/dead-letter-operator-contracts";

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

function valueOrDash(value: string | number | undefined) {
  return value === undefined || value === "" ? "—" : String(value);
}

export function DeadLetterDetail({ jobId }: { jobId: string }) {
  const [view, setView] = useState<DeadLetterOperatorView | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [reason, setReason] = useState("Reviewed by owner/admin");
  const [replacementJobId, setReplacementJobId] = useState("");
  const [credentialLeaseId, setCredentialLeaseId] = useState("");

  const endpoint = useMemo(
    () => "/api/control/jobs/dead-letters/" + encodeURIComponent(jobId),
    [jobId]
  );

  const load = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const body = await response.json() as Envelope<DeadLetterOperatorView>;
    if (!body.ok) throw new Error(body.error.message);
    setView(body.data);
    setError("");
  }, [endpoint]);

  useEffect(() => {
    void load().catch((value: unknown) =>
      setError(value instanceof Error ? value.message : "Unable to load dead-lettered Job")
    );
  }, [load]);

  async function act(action: "retry" | "cancel" | "dismiss") {
    setWorking(true);
    setError("");
    try {
      const payload = action === "retry"
        ? {
            action,
            reason,
            replacementJobId,
            ...(credentialLeaseId.trim() ? { credentialLeaseId: credentialLeaseId.trim() } : {})
          }
        : { action, reason };
      const response = await fetch(endpoint + "/actions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID()
        },
        body: JSON.stringify(payload)
      });
      const body = await response.json() as Envelope<DeadLetterOperatorActionResult>;
      if (!body.ok) throw new Error(body.error.message);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Dead-letter action failed");
    } finally {
      setWorking(false);
    }
  }

  if (!view && !error) return <div className="dead-letter-empty">Loading failure lineage…</div>;
  if (!view) return <div className="dead-letter-error">{error}</div>;

  return (
    <div className="dead-letter-detail">
      {error ? <div className="dead-letter-error">{error}</div> : null}

      <section className="dead-letter-hero">
        <span>Disposition</span>
        <strong>{view.disposition}</strong>
        <small>{view.deadLetter.reason}</small>
      </section>

      <section className="dead-letter-panel">
        <h2>Failure lineage</h2>
        <dl className="dead-letter-facts">
          <div><dt>Job</dt><dd>{view.jobId}</dd></div>
          <div><dt>Task</dt><dd>{view.taskId}</dd></div>
          <div><dt>Runtime</dt><dd>{view.runtime.state}</dd></div>
          <div><dt>Attempt</dt><dd>{view.runtime.attempt}</dd></div>
          <div><dt>Failed</dt><dd>{new Date(view.deadLetter.failedAt).toLocaleString()}</dd></div>
          <div><dt>Lineage hash</dt><dd className="mono">{view.lineageHash}</dd></div>
        </dl>
      </section>

      <section className="dead-letter-panel">
        <h2>Retry history</h2>
        {view.retries.length === 0 ? <p>No scheduled retries were recorded.</p> : (
          <div className="dead-letter-history">
            {view.retries.map((item) => (
              <article key={item.id}>
                <strong>Attempt {item.nextAttempt}</strong>
                <span>{item.reason}</span>
                <small>{new Date(item.runAt).toLocaleString()}</small>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="dead-letter-panel">
        <h2>Provider evidence</h2>
        {view.providerEvidence.length === 0 ? <p>No provider execution record was persisted.</p> : (
          <div className="dead-letter-history">
            {view.providerEvidence.map((item) => (
              <article key={item.requestId}>
                <strong>{item.adapterId} · {item.state}</strong>
                <span>Provider object: {valueOrDash(item.providerOperationId)}</span>
                <small className="mono">request {item.requestId}</small>
                <small className="mono">record {item.recordHash}</small>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="dead-letter-panel">
        <h2>Verification evidence</h2>
        {view.verificationEvidence.length === 0 ? <p>No verification evidence was established.</p> : (
          <div className="dead-letter-history">
            {view.verificationEvidence.map((item) => (
              <article key={item.id}>
                <strong>{item.result} · {item.strategy}</strong>
                <span>{item.sourceType}: {item.sourceId}</span>
                <small>{new Date(item.observedAt).toLocaleString()}</small>
                <small className="mono">{item.evidenceHash}</small>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="dead-letter-panel">
        <h2>Operator actions</h2>
        {view.operatorActions.length === 0 ? <p>No operator action has been taken.</p> : (
          <div className="dead-letter-history">
            {view.operatorActions.map((item, index) => (
              <article key={item.eventType + item.occurredAt + index}>
                <strong>{item.eventType}</strong>
                <span>{item.reason ?? "No reason recorded"}</span>
                <small>{new Date(item.occurredAt).toLocaleString()} · {item.actorId}</small>
                {item.replacementJobId ? <small>Replacement: {item.replacementJobId}</small> : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="dead-letter-panel dead-letter-operator">
        <h2>Safe operator action</h2>
        <p>
          Retry never replays the old provider operation. It requires a different queued Job with
          fresh authoritative grant/consumption lineage and creates a new request/idempotency lineage.
        </p>
        <label>
          Reason
          <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} />
        </label>
        <label>
          Replacement Job ID
          <input
            value={replacementJobId}
            onChange={(event) => setReplacementJobId(event.target.value)}
            placeholder="Required only for retry"
          />
        </label>
        <label>
          New credential lease ID
          <input
            value={credentialLeaseId}
            onChange={(event) => setCredentialLeaseId(event.target.value)}
            placeholder="Required for production provider actions"
          />
        </label>
        <div className="dead-letter-actions">
          <button
            type="button"
            className="primary-action"
            disabled={
              working
              || !view.retrySafety.automaticRedriveSupported
              || replacementJobId.trim().length === 0
              || reason.trim().length === 0
            }
            onClick={() => void act("retry")}
          >
            Retry with new lineage
          </button>
          <button
            type="button"
            className="secondary-action"
            disabled={working || reason.trim().length === 0}
            onClick={() => void act("cancel")}
          >
            Cancel
          </button>
          <button
            type="button"
            className="secondary-action"
            disabled={working || reason.trim().length === 0}
            onClick={() => void act("dismiss")}
          >
            Dismiss
          </button>
        </div>
        {!view.retrySafety.automaticRedriveSupported ? (
          <small>
            This Job kind cannot be automatically redriven. Create a new governed plan/Job, then
            cancel or dismiss this dead letter.
          </small>
        ) : null}
      </section>
    </div>
  );
}
