"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { DecisionStatus } from "@/lib/types";

type DecisionAction = "approve" | "modify" | "reject";

function authoritativeRuntime() {
  return process.env.NEXT_PUBLIC_APP_ENV !== "development";
}

export function DecisionActions({
  decisionId,
  initialStatus
}: {
  decisionId: string;
  initialStatus: DecisionStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<DecisionStatus>(initialStatus);
  const [note, setNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function mutate(action: DecisionAction) {
    const next: DecisionStatus = action === "approve"
      ? "approved"
      : action === "modify"
        ? "modified"
        : "rejected";

    if (!authoritativeRuntime()) {
      setStatus(next);
      setNote(`Development preview status: ${next}. No server-side approval or side effect occurs.`);
      return;
    }

    if (submitting) return;
    setSubmitting(true);
    setNote("Saving authoritative decision...");
    try {
      const response = await fetch(`/api/control/decisions/${encodeURIComponent(decisionId)}`, {
        method: "PATCH",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID()
        },
        body: JSON.stringify({ action })
      });
      const value = await response.json().catch(() => null) as {
        ok?: boolean;
        data?: { status?: DecisionStatus };
        error?: { message?: string };
      } | null;
      if (!response.ok || !value?.ok || !value.data?.status) {
        throw new Error(value?.error?.message || "Decision mutation failed");
      }
      setStatus(value.data.status);
      setNote(`Authoritative status: ${value.data.status}.`);
      router.refresh();
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Decision mutation failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="decision-actions">
      <div className="inline-note">
        {note ?? (
          authoritativeRuntime()
            ? <>Authoritative status: <strong>{status}</strong>.</>
            : <>Development preview status: <strong>{status}</strong>. No server-side approval or side effect occurs.</>
        )}
      </div>
      <div className="action-grid">
        <button type="button" className="secondary-action" disabled={submitting} onClick={() => mutate("reject")}>Reject</button>
        <button type="button" className="secondary-action" disabled={submitting} onClick={() => mutate("modify")}>Modify</button>
        <button type="button" className="primary-action" disabled={submitting} onClick={() => mutate("approve")}>Approve</button>
      </div>
    </div>
  );
}
