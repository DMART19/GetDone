"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity, Ban, CalendarDays, CheckCircle2, ChevronDown, CircleOff,
  Github, Link2, Plus, RefreshCcw, ShieldCheck, SlidersHorizontal, X
} from "lucide-react";

type ProviderDefinition={
  provider:string;
  label:string;
  capabilities:readonly string[];
  suggestedScopes:readonly string[];
  supportsCredentialBinding:boolean;
};

type Verification={
  id:string;
  health:"unknown"|"healthy"|"degraded"|"unavailable";
  verifiedAt:string;
  evidenceHash:string;
  capabilityResults:Record<string,"passed"|"failed"|"not-tested">;
};

type Integration={
  id:string;
  portfolioId:string;
  companyId:string;
  environment:"development"|"staging"|"production";
  provider:string;
  displayName:string;
  capabilityNames:readonly string[];
  grantedScopes:readonly string[];
  credentialBindingId?:string;
  status:"pending"|"active"|"disabled"|"revoked";
  health:"unknown"|"healthy"|"degraded"|"unavailable";
  lastVerification?:Verification;
  version:number;
  updatedAt:string;
};

type Envelope<T>=
  | {ok:true;data:T}
  | {ok:false;error:{code:string;message:string}};

function providerIcon(provider:string){
  if(provider==="calendar") return CalendarDays;
  if(provider==="github") return Github;
  return Link2;
}

function healthLabel(value:Integration["health"]){
  if(value==="healthy") return "Healthy";
  if(value==="degraded") return "Degraded";
  if(value==="unavailable") return "Unavailable";
  return "Not verified";
}

function formatDate(value?:string){
  if(!value) return "Never";
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())) return "Never";
  return new Intl.DateTimeFormat(undefined,{
    month:"short",day:"numeric",hour:"numeric",minute:"2-digit"
  }).format(date);
}

export function IntegrationManager(){
  const [integrations,setIntegrations]=useState<Integration[]>([]);
  const [providers,setProviders]=useState<ProviderDefinition[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [editing,setEditing]=useState<Integration|null>(null);
  const [adding,setAdding]=useState(false);
  const [busy,setBusy]=useState("");

  async function load(){
    setLoading(true);
    setError("");
    try{
      const response=await fetch("/api/control/integrations",{cache:"no-store"});
      const payload=await response.json() as Envelope<{
        integrations:Integration[];
        providers:ProviderDefinition[];
      }>;
      if(!payload.ok) throw new Error(payload.error.message);
      setIntegrations(payload.data.integrations);
      setProviders(payload.data.providers);
    }catch(value){
      setError(value instanceof Error?value.message:"Unable to load integrations");
    }finally{
      setLoading(false);
    }
  }

  useEffect(()=>{void load();},[]);

  async function action(integration:Integration,kind:"enable"|"disable"|"revoke"){
    setBusy(integration.id+":"+kind);
    setError("");
    try{
      const response=await fetch(`/api/control/integrations/${encodeURIComponent(integration.id)}/actions`,{
        method:"POST",
        headers:{
          "content-type":"application/json",
          "idempotency-key":crypto.randomUUID()
        },
        body:JSON.stringify({action:kind,expectedVersion:integration.version})
      });
      const payload=await response.json() as Envelope<Integration>;
      if(!payload.ok) throw new Error(payload.error.message);
      await load();
    }catch(value){
      setError(value instanceof Error?value.message:"Integration action failed");
    }finally{
      setBusy("");
    }
  }

  const activeCount=integrations.filter((item)=>item.status==="active").length;
  const unhealthy=integrations.filter((item)=>item.health==="degraded"||item.health==="unavailable").length;

  return (
    <>
      <div className="integration-summary-grid">
        <article>
          <span>Configured</span>
          <strong>{integrations.length}</strong>
          <small>{activeCount} active</small>
        </article>
        <article>
          <span>Health</span>
          <strong>{unhealthy===0?"Clear":`${unhealthy} issue${unhealthy===1?"":"s"}`}</strong>
          <small>Evidence-based verification</small>
        </article>
      </div>

      <div className="integration-toolbar">
        <div>
          <h2>Connected systems</h2>
          <p>Secrets stay in the credential broker. This page stores references only.</p>
        </div>
        <button type="button" className="primary-action" onClick={()=>{setAdding(true);setEditing(null);}}>
          <Plus size={16}/> Add
        </button>
      </div>

      {error?<div className="integration-error">{error}</div>:null}
      {loading?<div className="integration-empty">Loading integrations…</div>:null}
      {!loading&&integrations.length===0?(
        <div className="integration-empty">
          <ShieldCheck size={24}/>
          <strong>No integrations configured</strong>
          <span>Add a provider using a brokered credential-binding reference. Raw credentials are never accepted here.</span>
        </div>
      ):null}

      <div className="integration-list">
        {integrations.map((integration)=>{
          const Icon=providerIcon(integration.provider);
          const working=busy.startsWith(integration.id+":");
          return (
            <article className="integration-card" key={integration.id}>
              <div className="integration-card-head">
                <span className="integration-provider-icon"><Icon size={20}/></span>
                <div>
                  <strong>{integration.displayName}</strong>
                  <small>{integration.provider} · {integration.companyId} / {integration.environment}</small>
                </div>
                <span className={`integration-status integration-status-${integration.status}`}>
                  {integration.status}
                </span>
              </div>

              <div className="integration-facts">
                <div>
                  <span>Capabilities</span>
                  <p>{integration.capabilityNames.join(", ")}</p>
                </div>
                <div>
                  <span>Granted scopes</span>
                  <p>{integration.grantedScopes.join(", ")}</p>
                </div>
                <div>
                  <span>Credential</span>
                  <p className="mono">{integration.credentialBindingId??"No broker binding yet"}</p>
                </div>
                <div>
                  <span>Health</span>
                  <p className={`integration-health health-${integration.health}`}>
                    <i/>{healthLabel(integration.health)}
                  </p>
                </div>
                <div>
                  <span>Last verification</span>
                  <p>{formatDate(integration.lastVerification?.verifiedAt)}</p>
                </div>
              </div>

              <div className="integration-actions">
                {integration.status!=="active"&&integration.status!=="revoked"?(
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={working}
                    onClick={()=>setEditing(integration)}
                  >
                    <SlidersHorizontal size={14}/> Configure
                  </button>
                ):null}
                {integration.status==="active"?(
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={working}
                    onClick={()=>void action(integration,"disable")}
                  >
                    <CircleOff size={14}/> Disable
                  </button>
                ):integration.status!=="revoked"&&integration.credentialBindingId?(
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={working}
                    onClick={()=>void action(integration,"enable")}
                  >
                    <CheckCircle2 size={14}/> Enable
                  </button>
                ):null}
                {integration.status!=="revoked"?(
                  <button
                    type="button"
                    className="danger-action"
                    disabled={working}
                    onClick={()=>void action(integration,"revoke")}
                  >
                    <Ban size={14}/> Revoke
                  </button>
                ):null}
              </div>
            </article>
          );
        })}
      </div>

      {(adding||editing)?(
        <IntegrationEditor
          providers={providers}
          existing={editing}
          onClose={()=>{setAdding(false);setEditing(null);}}
          onSaved={async()=>{setAdding(false);setEditing(null);await load();}}
          onError={setError}
        />
      ):null}
    </>
  );
}

function IntegrationEditor({
  providers,
  existing,
  onClose,
  onSaved,
  onError
}:{
  providers:ProviderDefinition[];
  existing:Integration|null;
  onClose:()=>void;
  onSaved:()=>Promise<void>;
  onError:(value:string)=>void;
}){
  const initialProvider=existing?.provider??providers[0]?.provider??"calendar";
  const [provider,setProvider]=useState(initialProvider);
  const definition=useMemo(
    ()=>providers.find((item)=>item.provider===provider)??providers[0],
    [provider,providers]
  );
  const [displayName,setDisplayName]=useState(existing?.displayName??"");
  const [capabilities,setCapabilities]=useState<string[]>([...(existing?.capabilityNames??definition?.capabilities??[])]);
  const [scopes,setScopes]=useState((existing?.grantedScopes??definition?.suggestedScopes??[]).join(", "));
  const [binding,setBinding]=useState(existing?.credentialBindingId??"");
  const [saving,setSaving]=useState(false);

  function changeProvider(value:string){
    setProvider(value);
    const next=providers.find((item)=>item.provider===value);
    setCapabilities([...(next?.capabilities??[])]);
    setScopes((next?.suggestedScopes??[]).join(", "));
    if(!existing) setDisplayName(next?.label??value);
  }

  async function submit(){
    if(!definition) return;
    setSaving(true);
    onError("");
    try{
      const grantedScopes=scopes.split(",").map((item)=>item.trim()).filter(Boolean);
      const response=existing
        ? await fetch(`/api/control/integrations/${encodeURIComponent(existing.id)}`,{
            method:"PATCH",
            headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},
            body:JSON.stringify({
              expectedVersion:existing.version,
              displayName,
              capabilityNames:capabilities,
              grantedScopes,
              credentialBindingId:binding.trim()||null
            })
          })
        : await fetch("/api/control/integrations",{
            method:"POST",
            headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},
            body:JSON.stringify({
              id:`${provider}-${crypto.randomUUID().slice(0,8)}`,
              provider,
              displayName,
              capabilityNames:capabilities,
              grantedScopes,
              ...(binding.trim()?{credentialBindingId:binding.trim()}: {})
            })
          });
      const payload=await response.json() as Envelope<Integration>;
      if(!payload.ok) throw new Error(payload.error.message);
      await onSaved();
    }catch(value){
      onError(value instanceof Error?value.message:"Unable to save integration");
    }finally{
      setSaving(false);
    }
  }

  return (
    <div className="integration-editor-backdrop" role="presentation">
      <section className="integration-editor" role="dialog" aria-modal="true" aria-label={existing?"Configure integration":"Add integration"}>
        <div className="integration-editor-head">
          <div>
            <h2>{existing?"Configure integration":"Add integration"}</h2>
            <p>Only broker references are stored. Never paste tokens, passwords, or client secrets.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={20}/>
          </button>
        </div>

        <label>
          <span>Provider</span>
          <div className="integration-select-wrap">
            <select value={provider} disabled={Boolean(existing)} onChange={(event)=>changeProvider(event.target.value)}>
              {providers.map((item)=><option key={item.provider} value={item.provider}>{item.label}</option>)}
            </select>
            <ChevronDown size={14}/>
          </div>
        </label>

        <label>
          <span>Name</span>
          <input value={displayName} onChange={(event)=>setDisplayName(event.target.value)} placeholder="Production Calendar"/>
        </label>

        <fieldset>
          <legend>Capabilities</legend>
          <div className="integration-checkboxes">
            {(definition?.capabilities??[]).map((capability)=>(
              <label key={capability}>
                <input
                  type="checkbox"
                  checked={capabilities.includes(capability)}
                  onChange={(event)=>setCapabilities((current)=>
                    event.target.checked
                      ? [...new Set([...current,capability])]
                      : current.filter((item)=>item!==capability)
                  )}
                />
                <span>{capability}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label>
          <span>Granted scopes</span>
          <input value={scopes} onChange={(event)=>setScopes(event.target.value)} placeholder="calendar.read, calendar.write"/>
          <small>Comma-separated scopes granted by the brokered credential.</small>
        </label>

        <label>
          <span>Credential binding reference</span>
          <input className="mono" value={binding} onChange={(event)=>setBinding(event.target.value)} placeholder="binding:calendar:prod"/>
          <small>Reference ID only. Secret material is redeemed server-side for each authorized Job.</small>
        </label>

        <div className="integration-editor-note">
          <Activity size={16}/>
          <span>Company and environment are bound from your authenticated owner session and cannot be overridden here.</span>
        </div>

        <div className="integration-editor-actions">
          <button type="button" className="secondary-action" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-action" disabled={saving||capabilities.length===0||!displayName.trim()} onClick={()=>void submit()}>
            {saving?<RefreshCcw size={15} className="spin"/>:<ShieldCheck size={15}/>}
            {existing?"Save":"Add integration"}
          </button>
        </div>
      </section>
    </div>
  );
}
