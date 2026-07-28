/**
 * StockMaster Service Worker (v1)
 *
 * 缓存策略:
 *   - app shell (CSS/JS/manifest/icons): cache-first
 *   - 行情 / LLM / akshare / Supabase API: network-only (不缓存, 数据要实时)
 *   - navigation: network-first → 失败 fallback cache
 *
 * 升级: CACHE_NAME 由 scripts/build-web.mjs 在每次 build 时自动重写为时间戳
 *       (拷到 www/sw.js 的产物上), 源文件此处保持占位, 无需手改版本号
 */
const CACHE_NAME = 'stockmaster-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => c.addAll(SHELL).catch((err) => {
        // 加 shell 失败也别阻塞 install (例如某个文件还没部署)
        console.warn('[SW] shell cache 部分失败:', err.message);
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 1) 跳过非同源 (Capacitor 内部 / chrome-extension)
  if (url.origin !== self.location.origin) return;
  // 2) API 路径不缓存 (实时数据)
  if (url.pathname.startsWith('/api/')) return;
  // 3) navigation: network-first
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        return resp;
      }).catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
    );
    return;
  }
  // 4) 其他 GET (静态资源): cache-first
  if (e.request.method !== 'GET') return;
  // KB JSON: network-first, 不缓存 (Tier 3B 教训)
  //   - KB 升级后必须立即生效, 不能被 SW 旧缓存拦截
  //   - KB 文本小 (~30KB), 没必要 cache-first
  //   - Dexie 的 KB_TTL (7 天) 才是真正的缓存控制点
  if (url.pathname.startsWith('/kb_data/')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((resp) => {
        if (resp.ok && (resp.type === 'basic' || resp.type === 'default')) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
