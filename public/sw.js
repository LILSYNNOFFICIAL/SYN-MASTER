const CACHE_NAME = 'syn-master-shell-v1';
const STATIC_ASSET = /\.(?:js|css|svg|png|jpg|jpeg|webp|ico|woff2|webmanifest)$/i;
const NEVER_CACHE = /(?:^\/api\/|\.onnx(?:$|\?)|\.ort(?:$|\?)|\/models?\/|\/demucs\/)/i;
const MAX_CACHEABLE_BYTES = 8 * 1024 * 1024;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('syn-master-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname)) return;

  const navigation = request.mode === 'navigate';
  if (!navigation && !STATIC_ASSET.test(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      const length = Number(response.headers.get('content-length') || 0);
      const cacheable = response.ok && (!length || length <= MAX_CACHEABLE_BYTES);
      if (cacheable) await cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request) || (navigation ? await cache.match('/') : undefined);
      if (cached) return cached;
      if (navigation) {
        return new Response(
          '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SYN MASTER offline</title><body style="background:#070709;color:#f7f8fa;font:16px system-ui;padding:2rem"><h1>SYN MASTER</h1><p>You are offline and no cached workstation page is available yet. Reconnect and reload to continue mastering.</p></body></html>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }
      return Response.error();
    }
  })());
});
