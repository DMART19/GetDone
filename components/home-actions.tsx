"use client";

import Link from "next/link";
import { BarChart3, CircleCheckBig, Plus, Server, ShieldCheck, Zap } from "lucide-react";
import { useState } from "react";

export function HomeActions() {
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="quick-actions">
      {note ? <div className="inline-note" role="status">{note}</div> : null}
      <button type="button" className="quick-action" onClick={() => setNote("Development preview: priority synthesis will connect to the future Control API.") }>
        <Zap size={22} /><span>Show me what’s important</span>
      </button>
      <button type="button" className="quick-action" onClick={() => setNote("Development preview: growth planning is intentionally not connected to a model yet.") }>
        <BarChart3 size={22} /><span>Work on growth</span>
      </button>
      <Link href="/resources" className="quick-action">
        <Server size={22} /><span>Check my resources</span><em>NEW</em>
      </Link>
      <Link href="/decisions" className="quick-action">
        <CircleCheckBig size={22} /><span>Check my decisions</span>
      </Link>
      <Link href="/operations/production-acceptance" className="quick-action">
        <ShieldCheck size={22} /><span>Production acceptance</span>
      </Link>
      <button type="button" className="quick-action" onClick={() => setNote("Use the message box below. Messages stay local in this visual baseline.") }>
        <Plus size={22} /><span>Tell me / Ask anything</span>
      </button>
    </div>
  );
}
