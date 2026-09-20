"use client";

import { Cloud, Database, Network, Server, Shapes, Warehouse, ArrowRight } from "lucide-react";
import { FormEvent, useState } from "react";

const choices = [
  { title: "Compute", detail: "Server, GPU, Raspberry Pi, VM, cluster, data center", icon: Server },
  { title: "Storage", detail: "NAS, cloud storage, backup, archive", icon: Database },
  { title: "Network", detail: "VPN, gateway, private link", icon: Network },
  { title: "Cloud Provider", detail: "AWS, Google Cloud, Azure, etc.", icon: Cloud },
  { title: "Data Center / Partner", detail: "Add a partner cluster or colo", icon: Warehouse },
  { title: "Other", detail: "Custom resource type", icon: Shapes }
] as const;

export function AddResourceChoices() {
  const [status, setStatus] = useState<string | null>(null);
  const [description, setDescription] = useState("");

  function pick(title: string) {
    setStatus(`${title} selected. Real enrollment is intentionally deferred to the governed Resource Fabric phase.`);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!description.trim()) return;
    setStatus(`Captured locally: “${description.trim()}”. No resource was enrolled.`);
    setDescription("");
  }

  return (
    <>
      <div className="choice-list">
        {choices.map(({ title, detail, icon: Icon }) => (
          <button key={title} type="button" className="choice-row" onClick={() => pick(title)}>
            <span className="choice-icon"><Icon size={24} /></span>
            <span><strong>{title}</strong><small>{detail}</small></span>
            <ArrowRight size={18} />
          </button>
        ))}
      </div>
      <form className="describe-card" onSubmit={submit}>
        <strong>Not sure?</strong>
        <p>Just describe it in plain language. I’ll figure it out.</p>
        <div className="describe-input">
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder='e.g. “Add my Raspberry Pi”' />
          <button type="submit" aria-label="Submit description"><ArrowRight size={19} /></button>
        </div>
      </form>
      {status ? <div className="inline-note" role="status">{status}</div> : null}
    </>
  );
}
