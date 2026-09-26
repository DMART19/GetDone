"use client";

import Link from "next/link";
import { ArrowUp, BarChart3, Box, ChevronRight, ClipboardList, Wrench } from "lucide-react";
import { FormEvent, useRef, useState } from "react";
import { Brand } from "@/components/brand";

function authoritativeRuntime() {
  return process.env.NEXT_PUBLIC_APP_ENV !== "development";
}

const actions = [
  { label: "Build something", icon: Box, prompt: "Build something new for the highest-priority company." },
  { label: "Grow revenue", icon: BarChart3, prompt: "Find the best revenue growth opportunity and make a plan." },
  { label: "Fix a problem", icon: Wrench, prompt: "Find the most important problem and propose the safest fix." },
  { label: "Give me an update", icon: ClipboardList, prompt: "Give me an owner update across my companies." }
] as const;

export function HomeDashboard({
  attentionCount,
  resourceCount,
  healthy
}: {
  attentionCount: number;
  resourceCount: number;
  healthy: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function choosePrompt(prompt: string) {
    setMessage(prompt);
    setNotice(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = message.trim();
    if (!clean || submitting) return;

    if (!authoritativeRuntime()) {
      setNotice("Queued locally for preview: “" + clean + "”");
      setMessage("");
      return;
    }

    setSubmitting(true);
    setNotice("Sending to GetDone...");
    try {
      const response = await fetch("/api/control/chat", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID()
        },
        body: JSON.stringify({ message: clean, channel: "chat" })
      });
      const value = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;

      if (!response.ok || !value?.ok) {
        throw new Error(value?.error?.message || "GetDone could not accept the request");
      }

      setMessage("");
      setNotice("Accepted by GetDone.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "GetDone could not accept the request");
    } finally {
      setSubmitting(false);
    }
  }

  const statusText = attentionCount > 0
    ? resourceCount + " resources connected · " + attentionCount + " decisions need attention."
    : resourceCount + " resources connected · Nothing urgent is waiting.";

  return (
    <section className="ufo-home" aria-label="GetDone owner chat">
      <div className="ufo-home-brand">
        <Brand />
        <h1 style={{ margin: 0, color: "#d9e3ee", fontSize: "17px", lineHeight: 1.35, fontWeight: 400 }}>
          How can I move things forward today?
        </h1>
      </div>

      <form className="ufo-command-card" onSubmit={submit}>
        <textarea
          ref={inputRef}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Just tell me what you want..."
          aria-label="Message GetDone"
          disabled={submitting}
          rows={4}
        />
        <button
          className="ufo-command-send"
          aria-label={authoritativeRuntime() ? "Send message" : "Send preview message"}
          type="submit"
          disabled={submitting || !message.trim()}
        >
          <ArrowUp size={22} />
        </button>
      </form>

      {notice ? <div className="ufo-home-notice" role="status">{notice}</div> : null}

      <div className="ufo-action-grid" aria-label="Quick actions">
        {actions.map(({ label, icon: Icon, prompt }) => (
          <button key={label} type="button" onClick={() => choosePrompt(prompt)}>
            <Icon size={20} strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <Link href={attentionCount > 0 ? "/decisions" : "/resources"} className="ufo-working-card">
        <span className={healthy ? "ufo-live-dot" : "ufo-live-dot ufo-live-dot-warning"} />
        <span>
          <strong>GetDone is working for you</strong>
          <small>{statusText}</small>
        </span>
        <ChevronRight size={20} />
      </Link>

      <div className="ufo-horizon" aria-hidden="true">
        <span>IDEAS TODAY.<br />A BRIGHTER TOMORROW.</span>
      </div>
    </section>
  );
}
