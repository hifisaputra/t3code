// Service worker for t3code Web Push notifications.
// Receives push messages and focuses/opens the relevant thread on click.

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || "T3 Code";
  const options = {
    body: payload.body || "",
    icon: "/favicon-32x32.png",
    badge: "/favicon-32x32.png",
    data: { url: payload.url || "/" },
    // Same tag replaces an earlier notification for the same thread.
    ...(payload.tag ? { tag: payload.tag } : {}),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client && targetUrl) {
            try {
              await client.navigate(targetUrl);
            } catch {
              // Cross-origin or detached client; ignore.
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })(),
  );
});
