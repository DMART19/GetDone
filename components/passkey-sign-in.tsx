"use client";

import { FormEvent, useState } from "react";
import {
  getPasskeyAssertion,
  type BrowserPasskeyChallenge
} from "@/lib/auth/webauthn-browser";

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { message?: string };
};

async function json<T>(response: Response): Promise<Envelope<T>> {
  return await response.json().catch(() => ({ ok: false })) as Envelope<T>;
}

export function PasskeySignIn() {
  const [userId, setUserId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const identity = userId.trim();
    if (!identity || busy) return;
    setBusy(true);
    setStatus("Waiting for your passkey...");
    try {
      const beginResponse = await fetch("/api/control/auth/sign-in/begin", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: identity })
      });
      const begin = await json<BrowserPasskeyChallenge & {
        challengeId: string;
        expiresAt: string;
      }>(beginResponse);
      if (!beginResponse.ok || !begin.ok || !begin.data) {
        throw new Error(begin.error?.message || "Passkey sign-in could not start");
      }

      const credential = await getPasskeyAssertion(begin.data);
      const verifyResponse = await fetch("/api/control/auth/sign-in/verify", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: begin.data.challengeId,
          credential
        })
      });
      const verified = await json<{ expiresAt: string }>(verifyResponse);
      if (!verifyResponse.ok || !verified.ok) {
        throw new Error(verified.error?.message || "Passkey sign-in failed");
      }

      setStatus("Signed in.");
      window.location.assign("/");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Passkey sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="passkey-sign-in" onSubmit={submit}>
      <label>
        GetDone user
        <input
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          autoComplete="username webauthn"
          disabled={busy}
          required
        />
      </label>
      <button type="submit" className="primary-action" disabled={busy}>
        {busy ? "Authenticating..." : "Sign in with passkey"}
      </button>
      {status ? <p role="status">{status}</p> : null}
    </form>
  );
}
