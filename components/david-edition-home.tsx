"use client";
import {useEffect,useState} from "react";
import {BusinessSystem} from "@/components/business-system";
import {Orbit, Radar, ShieldAlert, ArrowUpRight} from "lucide-react";
import Link from "next/link";
/** Only load the optional visual scene if its built assets exist. The real business view always remains available. */
export function DavidEditionHome(){
 const [scene,setScene]=useState(false);
 const [mode,setMode]=useState<"command"|"explore">("command");
 useEffect(()=>{let active=true;fetch("/universe-assets/index.html",{method:"HEAD",cache:"no-store"}).then(r=>{if(active)setScene(r.ok)}).catch(()=>{});return()=>{active=false}},[]);
 return <section className="de-home">
  <div className="de-home-top"><div><span className="de-eyebrow">OWNER 01 / COMMAND BRIDGE</span><h1>Portfolio command</h1><p>Your authenticated business universe. Attention and health require verified evidence.</p></div><div className="de-modes"><button type="button" aria-pressed={mode==="command"} onClick={()=>setMode("command")}>Command</button><button type="button" aria-pressed={mode==="explore"} onClick={()=>setMode("explore"}>Explore</button></div></div>
  <div className="de-actions"><Link href="/decisions"><ShieldAlert size={19}/><span><strong>What needs me?</strong><small>Review owner decisions</small></span><ArrowUpRight size={16}/></Link><Link href="/resources"><Radar size={19}/><span><strong>Trace an issue</strong><small>Inspect real resource records</small></span><ArrowUpRight size={16}/></Link></div>
  {mode==="explore"&&scene?<div className="de-scene"><iframe title="GetDone universe visual navigation" src="/universe-assets/index.html?embedded=1" loading="lazy"/><button type="button" onClick={()=>setMode("command")}>Return to command</button></div>:<div className="de-live-catalog"><div className="de-catalog-heading"><Orbit size={18}/><strong>{mode==="explore"?"Authorized business universe":"Business operations"}</strong><span>LIVE DATA · EXISTING GETDONE API</span></div><BusinessSystem/></div>}
 </section>;
}