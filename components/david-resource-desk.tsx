import {Orbit, Network} from "lucide-react";
import {ResourceOverview} from "@/components/resource-overview";
import type {OwnerResourceSummary} from "@/lib/data/repository";
import type {Resource} from "@/lib/types";
export function DavidResourceDesk({summary,resources}:{summary:OwnerResourceSummary;resources:Resource[]}){
 const attention=resources.filter(r=>r.health==="degraded"||r.health==="offline").length;
 return <section className="de-desk"><div className="de-caption"><Orbit size={15}/> DAVID EDITION / OWNER 01 / RESOURCE NETWORK</div><div className="de-brief"><div><span className="de-eyebrow">● AUTHORITATIVE RESOURCE REGISTRY</span><h1>Resource command</h1><p>Inspect real connected systems and their GetDone-reported state.</p></div><div className="de-chips"><span className="de-chip"><Network size={14}/>{resources.length} resources</span><span className="de-chip urgent">{attention} need attention</span></div></div><div className="de-native-card"><ResourceOverview summary={summary} resources={resources}/></div></section>;
}