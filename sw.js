// Csak a saját, azonos eredetű GET kéréseket gyorsítótárazzuk (stale-while-
// revalidate). A külső API-hívások (Open-Meteo, BigDataCloud, GoatCounter,
// Cloudflare beacon) mind más eredetűek, ezért érintetlenül átmennek - nem
// szabad élő időjárási adatot gyorsítótárazni.
const CACHE_NAME = "holazeso-cache-v1";

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Esik!", body: "Elkezdett esni." };
  try {
    data = event.data.json();
  } catch (err) {
    console.error(err);
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
