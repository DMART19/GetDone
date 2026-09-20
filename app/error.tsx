"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("GetDone route error", error.digest ?? error.name);
  }, [error]);

  return (
    <div className="app-shell">
      <main className="screen state-page">
        <h1>Something didn’t load</h1>
        <p>GetDone kept the control surface in a safe state. Retry this view; no action is treated as completed because of a UI error.</p>
        <button type="button" className="primary-action" onClick={reset}>Try again</button>
      </main>
    </div>
  );
}
