self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("pesk-web-shell-"))
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((client) => "focus" in client);
        if (existing) return existing.focus();
        return url ? self.clients.openWindow(url) : undefined;
      }),
  );
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "Pesk update",
    body: "Open Pesk to see the latest update.",
    kind: "update",
  };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Use the default notification when a provider sends an empty payload.
  }
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const foreground = clients.some(
          (client) => client.visibilityState === "visible" && client.focused,
        );
        if (foreground) return;
        return self.registration.showNotification(payload.title, {
          body: payload.body,
          icon: "./pesk-tray.png",
          data: { url: payload.url ?? "./web-chat.html", kind: payload.kind },
          tag: `pesk-codex-${payload.kind}`,
        });
      }),
  );
});
