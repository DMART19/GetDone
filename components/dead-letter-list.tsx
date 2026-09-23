"use client";

import Link from "next/link";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { DeadLetterSummary } from "@/lib/control-api/dead-letter-contracts";

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

export function DeadLetterList() {
  const [items, setItems] = useState<readonly DeadLetterSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void fetch("/api/control/jobs/dead-letters", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as Envelope<readonly DeadLetterSummary[]>;
        if (!body.ok) throw new Error(body.error.message);
        if (active) setItems(body.data);
      })
      .catch((value: unknown) => {
        if (active) setError(value instanceof Error ? value.message : "Unable to load dead-lettered Jobs");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  if (loading) return <div className="dead-letter-empty">Loading dead-lettered Jobs…</div>;
  if (error) return <div className="dead-letter-error">{error}</div>;
  if (items.length === 0) {
    return <div className="dead-letter-empty">No dead-lettered Jobs need operator review.</div>;
  }

  return (
    <div className="dead-letter-list">
      {items.map((item) => (
        <Link
          key={item.jobId}
          href={"/operations/dead-letters/" + encodeURIComponent(item.jobId)}
          className="dead-letter-row"
        >
          <span className="dead-letter-icon"><AlertTriangle size={18} /></span>
          <span className="dead-letter-copy">
            <strong>{item.jobId}</strong>
            <small>{item.reason}</small>
            <span>
              Attempt {item.finalAttempt} · {item.disposition} · {new Date(item.failedAt).toLocaleString()}
            </span>
          </span>
          <ChevronRight size={17} />
        </Link>
      ))}
    </div>
  );
}
