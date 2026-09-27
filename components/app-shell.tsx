import { useEffect, useRef, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { BottomNav } from "@/components/bottom-nav";
import { OfflineNotice } from "@/components/offline-notice";

export function AppShell({ children, navigation = true }: { children: ReactNode; navigation?: boolean }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const screenRef = useRef<HTMLElement>(null);

  useEffect(() => {
    screenRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="app-shell">
      <OfflineNotice />
      <main ref={screenRef} className={navigation ? "screen with-nav" : "screen"}>{children}</main>
      {navigation ? <BottomNav /> : null}
    </div>
  );
}
