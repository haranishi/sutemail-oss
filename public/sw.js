/* 捨てメール（仮）の Service Worker。docs/01_requirements.md FR-15・FR-17 が正本。
   ・シェル（トップ・app.js・app.css・shared/*・manifest・静的3ページ）だけキャッシュする
   ・/api/* は絶対にキャッシュしない（本文は消える前提のデータなので端末に残さない）
   ・push は Declarative Web Push 非対応ブラウザ向けのフォールバック。通知本文にコードは載せない */

const CACHE = "sutemail-shell-v1";
const SHELL = [
  "/",
  "/app.css",
  "/app.js",
  "/shared/share.css",
  "/shared/share.js",
  "/manifest.webmanifest",
  "/terms",
  "/privacy",
  "/external-transmission",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 1つでも取れないと addAll は全部失敗するので、1件ずつ入れて失敗は捨てる
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // APIは素通し。キャッシュもしない
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached =
      (await caches.match(request)) ||
      (request.mode === "navigate" ? await caches.match("/") : undefined);
    if (cached) return cached;
    return new Response("オフラインです。電波の届く場所で開き直してください。", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const notification = payload.notification ?? {};
  // ロック画面に出るので、ここにコードを入れてはいけない
  const title = notification.title || "認証コードが届きました";
  const body = notification.body || "タップしてコードを確認";
  const navigate = typeof notification.navigate === "string" ? notification.navigate : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: "sutemail-message",
      data: { url: navigate },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ("navigate" in client) await client.navigate(target);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
