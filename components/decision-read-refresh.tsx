"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Revalidates authorized server-rendered decision state; does not mutate decisions. */
export function DecisionReadRefresh() {
  const router = useRouter();
  const [lastAttempt, setLastAttempt] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      router.refresh();
      setLastAttempt(new Date().toISOString());
    };
    const onFocus = () => refresh();
    const interval = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [router]);
  return <p className="de-decision-sync" role="status">Server-sourced decision queue · automatic refresh every 30 seconds{lastAttempt ? ` · refreshed ${new Date(lastAttempt).toLocaleTimeString()}` : ""}</p>;
}
