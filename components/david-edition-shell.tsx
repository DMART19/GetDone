"use client";
import type {ReactNode} from "react";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {Orbit, ShieldCheck, Network, Crown} from "lucide-react";
import {OfflineNotice} from "@/components/offline-notice";
const routes=[{href:"/",label:"Command",Icon:Orbit},{href:"/decisions",label:"Decisions",Icon:ShieldCheck},{href:"/resources",label:"Resources",Icon:Network}];
export function DavidEditionShell({children,className=""}:{children:ReactNode;className?:string}){
 const pathname=usePathname();
 return <div className={`david-edition app-shell ${className}`}>
  <OfflineNotice/>
  <header className="de-header">
   <Link href="/" className="de-brand"><span className="de-emblem"><Orbit size={23}/></span><span><strong>GETDONE</strong><small>DAVID EDITION <span>✦</span> OWNER COMMAND</small></span></Link>
   <nav className="de-desktop-nav" aria-label="David Edition navigation">{routes.map(({href,label,Icon})=><Link key={href} href={href} aria-current={pathname===href?"page":undefined}><Icon size={16}/>{label}</Link>)}</nav>
   <span className="de-edition-mark"><Crown size={15}/> PRIVATE BRIDGE · 01</span>
  </header>
  <main className="de-main" id="main-content">{children}</main>
  <nav className="de-mobile-nav" aria-label="David Edition mobile navigation">{routes.map(({href,label,Icon})=><Link key={href} href={href} aria-current={pathname===href?"page":undefined}><Icon size={20}/><span>{label}</span></Link>)}</nav>
 </div>
}