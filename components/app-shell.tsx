import { DavidEditionShell } from "@/components/david-edition-shell";
import type { ReactNode } from "react";

export function AppShell({ children, className = "" }: { children: ReactNode; navigation?: boolean; className?: string }) {
  return <DavidEditionShell className={className}>{children}</DavidEditionShell>;
}
