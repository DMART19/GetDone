"use client";

import { useEffect } from "react";

export function PwaRuntime() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let registration: ServiceWorkerRegistration | undefined;
    let updateListener: (() => void) | undefined;

    const announceReconnect = () => {
      window.dispatchEvent(new CustomEvent("getdone:reconnected"));
    };

    const checkForUpdate = () => {
      if (document.visibilityState === "visible") {
        void registration?.update();
      }
    };

    window.addEventListener("online", announceReconnect);
    document.addEventListener("visibilitychange", checkForUpdate);

    void navigator.serviceWorker.register("/sw.js", { scope: "/" })
      .then((registered) => {
        registration = registered;
        updateListener = () => {
          const installing = registered.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed"
              && navigator.serviceWorker.controller
            ) {
              window.dispatchEvent(new CustomEvent("getdone:pwa-update-available"));
            }
          });
        };
        registered.addEventListener("updatefound", updateListener);
        void registered.update();
      })
      .catch(() => undefined);

    return () => {
      window.removeEventListener("online", announceReconnect);
      document.removeEventListener("visibilitychange", checkForUpdate);
      if (registration && updateListener) {
        registration.removeEventListener("updatefound", updateListener);
      }
    };
  }, []);

  return null;
}
