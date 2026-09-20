import type { ReactNode } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { OfflineNotice } from "@/components/offline-notice";

export function AppShell({ children, navigation = true }: { children: ReactNode; navigation?: boolean }) {
  return (
    <div className="app-shell">
      <OfflineNotice />
      <main className={navigation ? "screen with-nav" : "screen"}>{children}</main>
      {navigation ? <BottomNav /> : null}
    </div>
  );
}
