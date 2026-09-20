"use client";

import { ArrowUp, Paperclip } from "lucide-react";
import { FormEvent, useState } from "react";

export function ChatComposer() {
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const clean = message.trim();
    if (!clean) return;
    setPreview(`Queued locally for preview: “${clean}”`);
    setMessage("");
  }

  return (
    <div className="composer-wrap">
      {preview ? <div className="local-toast" role="status">{preview}</div> : null}
      <form className="composer" onSubmit={submit}>
        <button type="button" className="composer-icon" aria-label="Attach"><Paperclip size={20} /></button>
        <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Message GetDone..." aria-label="Message GetDone" />
        <button className="send-button" aria-label="Send preview message" type="submit"><ArrowUp size={20} /></button>
      </form>
    </div>
  );
}
