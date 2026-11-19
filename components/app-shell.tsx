import type { ReactNode } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { OfflineNotice } from "@/components/offline-notice";
import { DavidEditionShell } from "@/components/david-edition-shell";

/** Server-selected shell. Flag OFF preserves the original navigation and layout. */
export function AppShell({ children, navigation = true, className = "" }: { children: ReactNode; navigation?: boolean; className?: string }) {
  if (process.env.GETDONE_DAVID_EDITION === "true") {
    return <DavidEditionShell className={className}>{children}</DavidEditionShell>;
  }
  return (
    <div className={`app-shell ${className}`}>
      <OfflineNotice />
      <main className={navigation ? "screen with-nav" : "screen"}>{children}</main>
      {navigation ? <BottomNav /> : null}
    </div>
  );
}
