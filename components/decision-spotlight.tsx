"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BarChart3, Bug, CheckCircle2, ChevronRight, Megaphone, Server, Users } from "lucide-react";
import { useMemo, useState } from "react";
import {
  getPasskeyAssertion,
  type BrowserPasskeyChallenge
} from "@/lib/auth/webauthn-browser";
import { DecisionCard } from "@/components/decision-card";
import type { Decision } from "@/lib/types";

const icons = {
  resource: Server,
  growth: BarChart3,
  incident: Bug,
  budget: Megaphone,
  outreach: Users
} as const;

function authoritativeRuntime() {
  return process.env.NEXT_PUBLIC_APP_ENV !== "development";
}

function labelFor(decision: Decision) {
  if (decision.category === "resource") return "New Resource Proposal";
  if (decision.category === "growth") return "Frontend Review";
  if (decision.category === "incident") return "Incident Review";
  if (decision.category === "budget") return "Budget Decision";
  return "Outreach Review";
}

async function envelope<T>(response: Response): Promise<{
  ok?: boolean;
  data?: T;
  error?: { message?: string };
}> {
  return await response.json().catch(() => ({}));
}

async function performPasskeyStepUp() {
  const beginResponse = await fetch("/api/control/auth/step-up/begin", {
    method: "POST",
    cache: "no-store"
  });
  const begin = await envelope<BrowserPasskeyChallenge & {
    challengeId: string;
    expiresAt: string;
  }>(beginResponse);

  if (!beginResponse.ok || !begin.ok || !begin.data) {
    throw new Error(begin.error?.message || "Passkey step-up could not start");
  }

  const credential = await getPasskeyAssertion(begin.data);
  const verifyResponse = await fetch("/api/control/auth/step-up/verify", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: begin.data.challengeId,
      credential
    })
  });
  const verified = await envelope<{ stepUpAuthenticatedAt: string }>(verifyResponse);
  if (!verifyResponse.ok || !verified.ok || !verified.data?.stepUpAuthenticatedAt) {
    throw new Error(verified.error?.message || "Passkey step-up failed");
  }
}

export function DecisionSpotlight({ decisions }: { decisions: Decision[] }) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pending = useMemo(
    () => decisions.filter((decision) => decision.status === "pending" && !dismissed.has(decision.id)),
    [decisions, dismissed]
  );
  const focus = pending.filter((decision) => decision.priority !== "fyi").slice(0, 2);
  const focusIds = new Set(focus.map((decision) => decision.id));
  const remaining = decisions.filter((decision) => !focusIds.has(decision.id));

  function notNow(id: string) {
    setDismissed((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    setNotice("Hidden for this session. No authoritative decision was changed.");
  }

  async function approve(decision: Decision) {
    if (!authoritativeRuntime()) {
      setNotice("Development preview status: approved. No server-side approval or side effect occurs.");
      setDismissed((current) => new Set([...current, decision.id]));
      return;
    }

    if (busyId) return;
    setBusyId(decision.id);
    setNotice("Saving authoritative decision...");
    const idempotencyKey = crypto.randomUUID();

    async function sendMutation() {
      const response = await fetch("/api/control/decisions/" + encodeURIComponent(decision.id), {
        method: "PATCH",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        },
        body: JSON.stringify({ action: "approve" })
      });
      return {
        response,
        value: await envelope<{ status?: string }>(response)
      };
    }

    try {
      let result = await sendMutation();
      const message = result.value.error?.message ?? "";
      if (result.response.status === 403 && /step-up/i.test(message)) {
        setNotice("Passkey approval required...");
        await performPasskeyStepUp();
        result = await sendMutation();
      }

      if (!result.response.ok || !result.value.ok || result.value.data?.status !== "approved") {
        throw new Error(result.value.error?.message || "Decision approval failed");
      }

      setNotice("Approved. GetDone is continuing the authorized work.");
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Decision approval failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="ufo-decision-stack">
      {notice ? <div className="ufo-inline-status" role="status">{notice}</div> : null}

      {focus.length ? focus.map((decision) => {
        const Icon = icons[decision.category];
        const previewFirst = decision.category === "growth";
        return (
          <article key={decision.id} className="ufo-decision-card">
            <div className="ufo-decision-kicker">
              <span className={"ufo-decision-icon ufo-decision-icon-" + decision.category}>
                <Icon size={22} />
              </span>
              <strong>{labelFor(decision)}</strong>
              <small>{decision.age}</small>
            </div>
            <h2>{decision.title}</h2>
            <p>{decision.subtitle}</p>
            <div className="ufo-decision-actions">
              {previewFirst ? (
                <Link href={"/decisions/" + encodeURIComponent(decision.id)} className="ufo-primary-button">
                  Open Preview
                </Link>
              ) : (
                <button
                  type="button"
                  className="ufo-primary-button"
                  disabled={busyId === decision.id}
                  onClick={() => approve(decision)}
                >
                  Approve
                </button>
              )}
              <button
                type="button"
                className="ufo-secondary-button"
                disabled={busyId === decision.id}
                onClick={() => notNow(decision.id)}
              >
                Not Now
              </button>
            </div>
          </article>
        );
      }) : (
        <div className="ufo-empty-attention">
          <CheckCircle2 size={24} />
          <strong>Nothing needs your attention right now.</strong>
          <span>GetDone will surface the next governed decision here.</span>
        </div>
      )}

      <div className="ufo-else-label">EVERYTHING ELSE</div>
      <details className="ufo-else">
        <summary>
          <CheckCircle2 size={22} />
          <span>{remaining.length} items available in the full decision queue</span>
          <ChevronRight size={18} />
        </summary>
        <div className="ufo-more-decisions">
          {remaining.length
            ? remaining.map((decision) => <DecisionCard key={decision.id} decision={decision} />)
            : <div className="empty-state">The decision queue is clear.</div>}
        </div>
      </details>
    </div>
  );
}
