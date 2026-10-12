"use client";

import { ArrowUp } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { DecisionActions } from "@/components/decision-actions";
import type { ThreadTurn } from "@/lib/conversation/thread-service";
import type { ConversationState, RegisteredBusiness } from "@/lib/conversation/understanding";

type Thread = { threadId: string; turns: ThreadTurn[]; state: ConversationState; businesses: RegisteredBusiness[] };
export function ChatComposer() {
  const [message, setMessage] = useState("");
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const currentId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const pending = useRef<{ message: string; key: string } | undefined>(undefined);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/control/chat${currentId.current ? `?threadId=${encodeURIComponent(currentId.current)}` : ""}`, { cache: "no-store", signal });
    const value = await response.json();
    if (!response.ok || !value.ok) throw new Error(value.error?.message || "Conversation could not be restored");
    if (!mounted.current || signal?.aborted) return;
    currentId.current = value.data.threadId;
    setThread(value.data);
    setLoading(false);
    setError(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal).catch(e => { if (!controller.signal.aborted) { setError(e.message); setLoading(false); } });
    return () => { mounted.current = false; controller.abort(); };
  }, [load]);
  const running = thread?.turns.some(turn => !turn.status.lifecycle.terminal);
  useEffect(() => {
    if (!running || submitting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await load(controller.signal); }
      catch { if (!controller.signal.aborted) setError("Connection interrupted. Work may still be running; retrying automatically."); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 4000);
    }
    timer = setTimeout(poll, 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [running, submitting, load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = message.trim();
    if (!clean || submitting || !currentId.current) return;
    setSubmitting(true);
    setError(null);
    if (pending.current?.message !== clean) pending.current = { message: clean, key: crypto.randomUUID() };
    try {
      const response = await fetch("/api/control/chat", {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json", "idempotency-key": pending.current.key },
        body: JSON.stringify({ message: clean, threadId: currentId.current, channel: "chat" })
      });
      const value = await response.json();
      if (!response.ok || !value.ok) throw new Error(value.error?.message || "Message was not accepted");
      pending.current = undefined;
      setMessage("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Connection failed. Your message is retained for retry."); }
    finally { if (mounted.current) setSubmitting(false); }
  }
  return <section className="composer-wrap" aria-label="Business conversation">
    <div className="chat-toolbar">
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "Hide conversation" : "Show conversation"}</button>
      <span>{thread?.state.activeBusiness?.name ?? "Choose a business by name"}</span>
    </div>
    {expanded && <div className="chat-thread" role="log" aria-label="Conversation history">
      {loading && <p role="status">Restoring conversation…</p>}
      {!loading && thread?.turns.length === 0 && <p>Ask about a registered business, investigate a finding, or propose work.</p>}
      {thread?.turns.map(({ record, status }) => <article key={record.id} className="chat-turn">
        <p className="chat-user"><strong>You</strong><br />{record.message}</p>
        <div className="chat-assistant"><strong>GetDone</strong>
          <p>{status.answer?.text ?? status.lifecycle.label}</p>
          {status.answer?.inboxItems?.length ? <ul>{status.answer.inboxItems.map(item => <li key={item.id}>
            {item.summary} — <a href={item.nextAction.href}>{item.nextAction.label}</a>
          </li>)}</ul> : null}
          {status.answer?.footer && <small aria-label="Operational evidence summary">
            {status.answer.footer.evidenceCount} evidence records
            {status.answer.footer.freshness && ` · oldest observed ${status.answer.footer.freshness}`}
            {status.answer.footer.confidence !== undefined && ` · confidence ${Math.round(status.answer.footer.confidence * 100)}%`}
            {status.answer.footer.missing?.map((missing, index) => <span key={index}> · {missing}</span>)}
            {status.answer.footer.deepLink && <a href={status.answer.footer.deepLink}> · {status.answer.footer.nextDecision ?? "Review"}</a>}
          </small>}
          {!status.answer && <p className="chat-progress" role="status">{status.lifecycle.label}{status.lifecycle.verified ? " — verification recorded" : ""}</p>}
          {status.answer?.evidenceRefs.length ? <details><summary>Evidence ({status.answer.evidenceRefs.length})</summary><ul>{status.answer.evidenceRefs.map(ref => <li key={ref}>{ref}</li>)}</ul></details> : null}
          {status.verificationRefs?.length ? <details open><summary>Verified results</summary><ul>{status.verificationRefs.map(ref => <li key={ref}>Verification receipt: {ref}</li>)}</ul></details> : null}
          {status.results?.map(result => <div key={result.jobId} className="chat-result">
            <p><strong>{result.explanation.title}</strong><br />{result.explanation.summary}</p>
            <p>Work: {result.explanation.authority.capabilityNames.join(", ") || result.jobId}. Verification: {result.explanation.verification.status}.</p>
            {result.failure && <p>{result.failure.safetyMessage}</p>}
          </div>)}
          {status.decisions?.map(decision => <div key={decision.id} className="chat-approval">
            {decision.preview && <details open><summary>Exact execution preview</summary>
              <p>{decision.preview.capability} · {decision.preview.resources.join(", ")}<br />{decision.preview.expectedResult}</p>
              <p>Business: {decision.preview.scope.companyId} · Approval: {decision.preview.approval}</p>
              <pre aria-label="Validated execution parameters">{JSON.stringify(decision.preview.parameters, null, 2)}</pre>
              <p>Effects: {decision.preview.sideEffects.join("; ") || "Read only"}<br />Non-effects: {decision.preview.nonEffects.join("; ")}</p>
              <p>Verification: {decision.preview.verificationMethod}<br />Expires: {decision.preview.expiresAt}</p>
              {decision.preview.estimatedCostCents !== undefined && <p>Estimated external cost: ${(decision.preview.estimatedCostCents / 100).toFixed(2)}</p>}
            </details>}
            <p>Proposed step: {decision.summary?.title ?? decision.stepId ?? decision.id}. {decision.requiresStepUp ? "Passkey confirmation required." : "Approval required."}</p>
            {decision.summary && <p>{decision.summary.expectedOutcome}<br />Estimated cost: ${(decision.summary.estimatedCostCents / 100).toFixed(2)}. Risk: {decision.summary.risk}.<br />Verification: {decision.summary.verification.join("; ")}</p>}
            {decision.status === "pending" && decision.summary ? <DecisionActions authoritative decisionId={decision.id} initialStatus={decision.status} portfolioId={record.portfolioId}
              onResolved={() => { void load().catch(() => setError("Approval saved. Refresh to check execution.")); }} /> : <p>Decision: {decision.status}. {decision.status === "pending" && <a href={`/decisions/${encodeURIComponent(decision.id)}`}>Review full scope before approving</a>}</p>}
          </div>)}
        </div>
      </article>)}
      {submitting && <p role="status">Understanding your message and selecting evidence…</p>}
    </div>}
    {error && <div className="local-toast" role="alert">{error} <button type="button" onClick={() => { void load().catch(e => setError(e.message)); }}>Retry loading</button></div>}
    <form className="composer" onSubmit={submit}>
      <input value={message} onChange={event => setMessage(event.target.value)} placeholder="Message GetDone…" aria-label="Message GetDone" disabled={submitting || loading} />
      <button className="send-button" aria-label="Send message" type="submit" disabled={submitting || loading || !thread || !message.trim()}><ArrowUp size={20} /></button>
    </form>
  </section>;
}
