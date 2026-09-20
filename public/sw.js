/* eslint-env serviceworker */

const SHELL_CACHE = "getdone-shell-v1";
const SHELL_ASSETS = ["/offline", "/icon.svg"];

function safeDestination(value) {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("..") || value.includes("\\")) {
    return "/";
  }
  return value;
}

function notificationCopy(attention) {
  if (attention === "critical") {
    return {
      title: "GetDone — Critical",
      body: "Open GetDone to review a critical item securely."
    };
  }
  if (attention === "high") {
    return {
      title: "GetDone — Attention needed",
      body: "Open GetDone to review an important item securely."
    };
  }
  return {
    title: "GetDone",
    body: "Open GetDone to review the latest item securely."
  };
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const offline = await caches.match("/offline");
        return offline || Response.error();
      })
    );
    return;
  }

  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const attention = payload.attention === "critical" || payload.attention === "high"
    ? payload.attention
    : "normal";
  const copy = notificationCopy(attention);
  const destination = safeDestination(payload.destination);

  event.waitUntil(
    self.registration.showNotification(copy.title, {
      body: copy.body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { destination },
      tag: typeof payload.id === "string" ? payload.id.slice(0, 120) : undefined
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = safeDestination(event.notification.data?.destination);
  event.waitUntil(self.clients.openWindow(destination));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
