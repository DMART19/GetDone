import { DavidEditionShell } from "@/components/david-edition-shell";
import type { ReactNode } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { OfflineNotice } from "@/components/offline-notice";

export function AppShell({ children, navigation = true, className = "" }: { children: ReactNode; navigation?: boolean; className?: string }) {
  return <DavidEditionShell className={className}>{children}</DavidEditionShell>;
}
