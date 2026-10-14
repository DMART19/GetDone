"use client";

import { ArrowUp, Paperclip } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";

function authoritativeRuntime() {
  return process.env.NEXT_PUBLIC_APP_ENV !== "development";
}

export function ChatComposer() {
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [turns, setTurns] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const pollAbort = useRef<AbortController | null>(null);
  useEffect(() => () => pollAbort.current?.abort(), []);

  async function pollStatus(intentId: string, controller: AbortController) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (controller.signal.aborted) return;
      const response = await fetch("/api/control/chat/" + encodeURIComponent(intentId), { cache: "no-store", signal: controller.signal });
      const value = await response.json().catch(() => null) as {
        ok?: boolean;
        data?: { lifecycle?: { label?: string; terminal?: boolean; verified?: boolean }; answer?: { text?: string } };
      } | null;
      if (!response.ok || !value?.ok || !value.data?.lifecycle) return;
      const reply = value.data.answer?.text ?? value.data.lifecycle.label ?? "GetDone is working…";
      setPreview(reply);
      setTurns(previous => previous.length && previous[previous.length - 1].role === "assistant"
        ? [...previous.slice(0, -1), { role: "assistant", text: reply }]
        : [...previous, { role: "assistant", text: reply }]);
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

    pollAbort.current?.abort();
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
      setTurns(previous => [...previous, { role: "user", text: clean }]);
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
      if (value.data?.id) {
        const controller = new AbortController();
        pollAbort.current = controller;
        void pollStatus(value.data.id, controller).catch(() => {
          if (!controller.signal.aborted) setPreview("Status refresh unavailable. Check the decision or objective record.");
        });
      }
    } catch (error) {
      setPreview(error instanceof Error ? error.message : "GetDone could not accept the message");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="composer-wrap">
      {turns.length ? <div className="de-chat-history" aria-label="Current conversation turns">{turns.map((turn, index) => <div key={index} className={`de-chat-turn de-chat-${turn.role}`}><strong>{turn.role === "user" ? "You" : "GetDone"}</strong><p>{turn.text}</p></div>)}</div> : null}
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
