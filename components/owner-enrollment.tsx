"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { createOwnerPasskey } from "@/lib/auth/webauthn-browser";

export function OwnerEnrollment() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState("");
  useEffect(() => {
    const invitation = window.location.hash.slice(1);
    if (invitation) { setToken(invitation); window.history.replaceState(null, "", window.location.pathname); }
  }, []);
  async function enroll() {
    setBusy(true); setStatus("Follow your device’s instructions to create your passkey.");
    try {
      const result = await createOwnerPasskey(token);
      setUserId(result.userId); setToken(""); setStatus("Your passkey is ready. Sign in to continue.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not create your passkey."); }
    finally { setBusy(false); }
  }
  return <section className="sign-in-card">
    <h1>Set up your owner passkey</h1>
    <p>Use your invitation to create a passkey on this device or a security key.</p>
    {!userId ? <>
      <label>Owner invitation<input type="password" autoComplete="off" value={token} disabled={busy} onChange={e => setToken(e.target.value)} /></label>
      <button className="primary-action" disabled={busy || !token} onClick={enroll}>Create owner passkey</button>
    </> : <><p>Your GetDone user: <strong>{userId}</strong></p><Link href="/sign-in">Sign in with your passkey</Link></>}
    {status && <p role="status">{status}</p>}
  </section>;
}
