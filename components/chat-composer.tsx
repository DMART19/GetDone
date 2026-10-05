"use client";

import { ArrowUp, Paperclip } from "lucide-react";
import { FormEvent, useState } from "react";

function authoritativeRuntime() {
  return process.env.NEXT_PUBLIC_APP_ENV !== "development";
}

export function ChatComposer() {
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function pollStatus(intentId: string) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const response = await fetch("/api/control/chat/" + encodeURIComponent(intentId), { cache: "no-store" });
      const value = await response.json().catch(() => null) as {
        ok?: boolean;
        data?: { lifecycle?: { label?: string; terminal?: boolean; verified?: boolean }; answer?: { text?: string } };
      } | null;
      if (!response.ok || !value?.ok || !value.data?.lifecycle) return;
      setPreview(value.data.answer?.text ?? value.data.lifecycle.label ?? "GetDone is working…");
      if (value.data.lifecycle.terminal) return;
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = message.trim();
    if (!clean || submitting) return;

    if (!authoritativeRuntime()) {
      setPreview(`Queued locally for preview: “${clean}”`);
      setMessage("");
      return;
    }

    setSubmitting(true);
    setPreview("Sending to GetDone...");
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
        data?: { id?: string; answer?: { text?: string }; conversation?: { intent?: string; continuation?: string; requiresExecutionAuthority?: boolean } };
        error?: { message?: string };
      } | null;
      if (!response.ok || !value?.ok) {
        throw new Error(value?.error?.message || "GetDone could not accept the message");
      }
      setMessage("");
      const intent = value.data?.conversation?.intent;
      setPreview(
        value.data?.answer?.text ?? (intent === "status_query" || intent === "explain_query"
          ? "Checking authoritative evidence…"
          : intent === "recommend_request" || intent === "investigate_request"
            ? "Building a grounded response…"
            : value.data?.conversation?.requiresExecutionAuthority
              ? "Request accepted. GetDone will plan it and ask before any action that requires approval."
              : "Request accepted. GetDone is resolving the right context.")
      );
      if (value.data?.id) void pollStatus(value.data.id);
    } catch (error) {
      setPreview(error instanceof Error ? error.message : "GetDone could not accept the message");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="composer-wrap">
      {preview ? <div className="local-toast" role="status">{preview}</div> : null}
      <form className="composer" onSubmit={submit}>
        <button type="button" className="composer-icon" aria-label="Attach"><Paperclip size={20} /></button>
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Message GetDone..."
          aria-label="Message GetDone"
          disabled={submitting}
        />
        <button
          className="send-button"
          aria-label={authoritativeRuntime() ? "Send message" : "Send preview message"}
          type="submit"
          disabled={submitting}
        >
          <ArrowUp size={20} />
        </button>
      </form>
    </div>
  );
}
