import { Cloud, Cpu, Database, Network, Server } from "lucide-react";
import type { Resource } from "@/lib/types";

const icons = { server: Server, gpu: Cpu, storage: Database, cloud: Cloud, network: Network } as const;

export function ResourceIcon({ icon, large = false }: { icon: Resource["icon"]; large?: boolean }) {
  const Icon = icons[icon];
  return (
    <span className={large ? "resource-icon large" : "resource-icon"}>
      <Icon size={large ? 30 : 20} strokeWidth={1.9} />
    </span>
  );
}
