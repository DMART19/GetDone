import type { ReactNode } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { OfflineNotice } from "@/components/offline-notice";

export function AppShell({ children, navigation = true, className = "" }: { children: ReactNode; navigation?: boolean; className?: string }) {
  return (
    <div className={`app-shell ${className}`}>
      <OfflineNotice />
      <main className={navigation ? "screen with-nav" : "screen"}>{children}</main>
      {navigation ? <BottomNav /> : null}
    </div>
  );
}
