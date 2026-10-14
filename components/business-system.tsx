"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { DavidUniverseScene } from "@/components/david-universe-scene";
import { summarizeBusinessCapabilities } from "@/lib/businesses/capability-summary";
import { businessSections, type Business, type BusinessContext, type BusinessSection } from "@/lib/businesses/contracts";

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  let message = "Business information could not be loaded. Please retry.";
  try {
    const response = await fetch(url, { cache: "no-store", signal });
    if (response.status === 401) message = "Your session has expired. Sign in again.";
    if (response.status === 403) message = "You do not have access to this business information.";
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (!result?.ok) throw new Error();
    return result.data;
  } catch {
    // Proxy HTML, parser details and transport errors are not owner-facing content.
    throw new Error(message);
  }
}

export function BusinessSystem({ cinematic = false }: { cinematic?: boolean }) {
  const [businesses, setBusinesses] = useState<Business[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Business | null>(null);
  const [context, setContext] = useState<BusinessContext | null>(null);
  const [contextError, setContextError] = useState("");
  const [contextRetry, setContextRetry] = useState(0);
  const [contextUpdatedAt, setContextUpdatedAt] = useState<string | null>(null);
  const [contextRefreshing, setContextRefreshing] = useState(false);
  const [contextStale, setContextStale] = useState(false);
  const [section, setSection] = useState<BusinessSection>("objectives");
  const panel = useRef<HTMLElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setBusinesses(null);
    void read<Business[]>("/api/businesses", controller.signal).then(setBusinesses).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setContext(null);
    setContextUpdatedAt(null);
    setContextStale(false);
    setContextError("");
    void read<BusinessContext>(`/api/businesses?portfolioId=${encodeURIComponent(selected.portfolioId)}`, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setContext(value); setContextUpdatedAt(new Date().toISOString()); } }).catch(error => { if (!controller.signal.aborted) setContextError(error.message); });
    panel.current?.focus();
    return () => controller.abort();
  }, [selected, contextRetry]);

  // Reconcile the selected business against the server on return to the tab and at
  // a bounded cadence. Do not erase the last good snapshot on a transient outage.
  useEffect(() => {
    if (!cinematic || !selected) return;
    const portfolioId = selected.portfolioId;
    let controller: AbortController | null = null;
    let stopped = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || controller) return;
      const pending = new AbortController();
      controller = pending;
      setContextRefreshing(true);
      try {
        const value = await read<BusinessContext>(`/api/businesses?portfolioId=${encodeURIComponent(portfolioId)}`, pending.signal);
        if (!stopped && !pending.signal.aborted) {
          setContext(value);
          setContextUpdatedAt(new Date().toISOString());
          setContextStale(false);
          setContextError("");
        }
      } catch {
        if (!stopped && !pending.signal.aborted) setContextStale(true);
      } finally {
        if (controller === pending) controller = null;
        if (!stopped) setContextRefreshing(false);
      }
    };
    const onReturn = () => { if (document.visibilityState === "visible") void refresh(); };
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      stopped = true;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [cinematic, selected]);

  const visible = businesses?.slice(page * 6, page * 6 + 6) ?? [];
  const positions = visible.map((_, index) => {
    const angle = (-90 + index * 360 / visible.length) * Math.PI / 180;
    return { x: 50 + Math.cos(angle) * 35, y: 50 + Math.sin(angle) * 38 };
  });
  // Guard against rendering a previous business's records during a selection change.
  const current = context?.business.portfolioId === selected?.portfolioId ? context : null;

  return (
    <section className="business-system" aria-labelledby="business-system-title">
      <header className="business-system-heading">
        <span className="business-eyebrow">YOUR BUSINESS OPERATING SYSTEM</span>
        <h1 id="business-system-title">One intelligence. Your businesses.</h1>
        <p>Information flows in. GetDone reasons across your businesses and coordinates authorized work.</p>
      </header>
      {cinematic && businesses?.length ? <DavidUniverseScene businesses={visible} selectedId={selected?.portfolioId ?? null} satellites={current?.sections.integrations.records} onSelect={(business, button) => { selectedButton.current = button; setSelected(business); setSection("objectives"); }} /> : <div className="business-universe" data-count={visible.length} data-empty={businesses?.length === 0 || !!error} aria-label="GetDone and your businesses" aria-busy={!businesses && !error}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" className="business-orbits">
          <ellipse cx="50" cy="50" rx="35" ry="38" />
          <ellipse cx="50" cy="50" rx="23" ry="25" />
          {positions.map((position, index) => <line key={index} x1="50" y1="50" x2={position.x} y2={position.y} />)}
        </svg>
        <div className="business-sun"><span aria-hidden="true">✦</span><strong>GetDone</strong><small>Intelligence &amp; control</small></div>
        {visible.map((business, index) => (
          <button key={business.portfolioId} className="business-planet" style={{ left: `${positions[index].x}%`, top: `${positions[index].y}%`, "--planet-hue": 185 + index * 37 } as CSSProperties}
            aria-label={`Open ${business.name}`} aria-pressed={selected?.portfolioId === business.portfolioId}
            aria-controls="business-context" onClick={event => { selectedButton.current = event.currentTarget; setSelected(business); setSection("objectives"); }}>
            <span className="business-planet-globe" aria-hidden="true" />
            <strong>{business.name}</strong><small>{business.lastActivityAt ? `Updated ${new Date(business.lastActivityAt).toLocaleDateString()}` : "No activity recorded"}</small>
          </button>
        ))}
      </div>}
      <div className="business-system-feedback">
        {!businesses && !error && <p role="status">Loading your businesses…</p>}
        {error && <div role="alert"><p>{error}</p><button onClick={() => setRetry(retry + 1)}>Retry businesses</button> <Link href="/sign-in">Sign in</Link></div>}
        {businesses?.length === 0 && <div className="business-empty">
          <h2>Your first business belongs here.</h2>
          <p>Connect a company to give GetDone a place to gather information, track objectives, and coordinate work.</p>
          <details><summary>Set up your first business</summary>
            <ol><li>Choose the company name and the owner who should have access.</li>
              <li>Ask your GetDone administrator to provision the company, portfolio, and owner memberships using the deployment onboarding guide.</li>
              <li>Use your owner invitation to enroll a passkey, then commission the integrations for that company.</li></ol>
            <p>Already have an invitation? <Link href="/setup/owner">Set up your owner access</Link>. If a company is missing, ask your administrator to check your memberships.</p>
          </details>
        </div>}
        {!!businesses?.length && <p className="business-legend">Connected lines: business information ↔ GetDone coordination<br />Select a planet to inspect its work. Actions remain subject to approval policies.</p>}
        {businesses && businesses.length > 6 && <nav aria-label="Business pages" className="business-pagination">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <span>{page + 1} / {Math.ceil(businesses.length / 6)}</span>
          <button disabled={(page + 1) * 6 >= businesses.length} onClick={() => setPage(page + 1)}>Next</button>
        </nav>}
      </div>
      {selected && <section id="business-context" ref={panel} tabIndex={-1} className="business-context" aria-label={`${selected.name} business context`}>
        <div className="business-context-heading"><div><span className="business-eyebrow">BUSINESS CONTEXT</span><h2>{selected.name}</h2></div>
          <button aria-label="Close business context" onClick={() => { setSelected(null); setContext(null); selectedButton.current?.focus(); }}>Close</button></div>
        {cinematic && <div className="de-context-sync" role="status"><span>{contextStale ? "Connection interrupted · showing last confirmed records" : contextRefreshing ? "Checking for updates…" : contextUpdatedAt ? `Last synchronized ${new Date(contextUpdatedAt).toLocaleTimeString()}` : "Waiting for authoritative records"}</span><button type="button" onClick={() => setContextRetry(value => value + 1)}>Refresh records</button></div>}
        {cinematic && current ? <section className="de-capability-map" aria-label="Business capability map"><h3>Capability &amp; connection map</h3><p>Derived from this business&apos;s authorized records. Record presence does not prove a live connection.</p><div>{summarizeBusinessCapabilities(current).map(capability => <article key={capability.section} data-state={capability.state}><strong>{capability.title}</strong><span>{capability.state.toUpperCase()} · {capability.recordCount} records</span><small>{capability.reason}</small><button type="button" onClick={() => setSection(capability.section)}>Inspect records</button></article>)}</div></section> : null}
        <nav aria-label="Business information" className="business-sections">{businessSections.map(item => <button key={item} aria-pressed={section === item} onClick={() => setSection(item)}>{item === "outcomes" ? "Recent outcomes" : item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
        {contextError ? <div role="alert"><p>{contextError}</p><button onClick={() => setContextRetry(contextRetry + 1)}>Retry business context</button></div> : !current ? <p role="status">Loading business context…</p> : <div aria-live="polite">
          <h3>{section === "outcomes" ? "Recent outcomes" : section[0].toUpperCase() + section.slice(1)}</h3>
          {current.sections[section].records.length ? <ul className="business-records">{current.sections[section].records.map(record => <li key={record.id}><strong>{record.title}</strong><span>{record.status.replaceAll("_", " ")}</span><time dateTime={record.updatedAt}>{new Date(record.updatedAt).toLocaleDateString()}</time></li>)}</ul> : <p>{section === "signals" ? "Signal feed unavailable." : `No ${section} recorded for this business.`}</p>}
          <small>{current.sections[section].note}</small>
        </div>}
      </section>}
    </section>
  );
}
