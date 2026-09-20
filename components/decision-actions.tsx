"use client";

import { useState } from "react";
import type { DecisionStatus } from "@/lib/types";

export function DecisionActions() {
  const [status, setStatus] = useState<DecisionStatus>("pending");

  function preview(next: DecisionStatus) {
    setStatus(next);
  }

  return (
    <div className="decision-actions">
      <div className="inline-note">Development preview status: <strong>{status}</strong>. No server-side approval or side effect occurs.</div>
      <div className="action-grid">
        <button type="button" className="secondary-action" onClick={() => preview("rejected")}>Reject</button>
        <button type="button" className="secondary-action" onClick={() => preview("modified")}>Modify</button>
        <button type="button" className="primary-action" onClick={() => preview("approved")}>Approve</button>
      </div>
    </div>
  );
}
