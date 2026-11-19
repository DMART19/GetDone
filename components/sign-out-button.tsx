"use client";

import { useState } from "react";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch("/api/control/auth/logout", { method: "POST", cache: "no-store" });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error("Logout failed");
      // A full navigation discards client state only after server revocation.
      window.location.replace("/sign-in");
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  return <div className="owner-sign-out">
    <button type="button" onClick={() => void signOut()} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</button>
    {error ? <span role="alert">Could not sign out. Please retry.</span> : null}
  </div>;
}
