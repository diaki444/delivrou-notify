// Service worker minimal : requis pour pouvoir installer l'appli sur
// l'ecran d'accueil (PWA) et pour recevoir des notifications push, meme
// quand l'appli n'est pas ouverte.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Pas de cache hors-ligne pour l'instant : on laisse passer les requetes
// normalement. Un gestionnaire "fetch" est quand meme requis par certains
// navigateurs pour proposer l'installation sur l'ecran d'accueil.
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = {};
  }
  const title = data.title || "Delivrou Notify";
  const options = {
    body: data.body || "Nouveau message",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/dashboard" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      if (list.length > 0 && "focus" in list[0]) {
        if ("navigate" in list[0]) list[0].navigate(url);
        return list[0].focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
