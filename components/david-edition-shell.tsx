"use client";
import type {ReactNode} from "react";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {Orbit, ShieldCheck, Network, Crown} from "lucide-react";
import {OfflineNotice} from "@/components/offline-notice";
const routes=[{href:"/",label:"Universe",Icon:Orbit},{href:"/decisions",label:"Decisions",Icon:ShieldCheck},{href:"/resources",label:"Resources",Icon:Network}];
export function DavidEditionShell({children,className=""}:{children:ReactNode;className?:string}){
 const pathname=usePathname();
 return <div className={`de-app app-shell ${className}`}>
  <OfflineNotice/>
  <header className="de-header">
   <Link href="/" className="de-brand"><span className="de-emblem"><Orbit size={23}/></span><span><strong>G E T D O N E</strong><small>DAVID EDITION / COMMAND 37</small></span></Link>
   <span className="de-goldmark">✦ DAVID EDITION <small>OWNER · 01</small></span>
   <nav className="de-topnav" aria-label="Primary navigation">{routes.map(({href,label,Icon})=><Link key={href} href={href} aria-current={pathname===href?"page":undefined}><Icon size={16}/>{label}</Link>)}</nav>
   <span className="de-owner"><Crown size={14}/> PRIVATE COMMAND BRIDGE</span>
  </header>
  <main className="de-main" id="main-content">{children}</main>
  <nav className="de-mobile-nav" aria-label="Mobile navigation">{routes.map(({href,label,Icon})=><Link key={href} href={href} aria-current={pathname===href?"page":undefined}><Icon size={19}/>{label}</Link>)}</nav>
 </div>;
}