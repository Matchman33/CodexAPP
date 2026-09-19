// 仅缓存应用外壳，不缓存账号接口、健康检查或聊天数据。
const CACHE = "codexapp-v21-proxied-file-links";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./history-feed.js", "./image-attachments.js", "./file-downloads.js", "./e2e.js", "./vendor/nacl.js", "./vendor/chat-ui.js", "./manifest.webmanifest", "./icon-180.png", "./icon-512.png"];
const shellPaths = new Set(SHELL.map((p) => new URL(p, self.location).pathname));
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("codexapp-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || !shellPaths.has(url.pathname) || url.search) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
    return res;
  }).catch(async () => (await caches.match(req)) || new Response("当前离线", { status: 503 })));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    if (self.clients.openWindow) return self.clients.openWindow("./");
  }));
});
