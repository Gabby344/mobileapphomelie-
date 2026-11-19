/**
 * Service Worker — cache hors-ligne.
 *  - Fichiers statiques de l'app : pré-cachés, servis "stale-while-revalidate".
 *  - Pages HTML : réseau d'abord (4 s max), sinon cache (connexion instable).
 *  - SDK Firebase (gstatic.com, URL versionnées) : pré-cachés récursivement, servis "cache d'abord".
 *  - Firestore / Auth / Storage : jamais interceptés (Firestore gère lui-même son cache via IndexedDB).
 * Pour forcer une mise à jour chez tous les utilisateurs : changer VERSION.
 */
const VERSION = "v1";
const STATIC_CACHE = `homelies-static-${VERSION}`;
const SDK_CACHE = "homelies-sdk-10.8.0";
const SDK_ROOT = "https://www.gstatic.com/firebasejs/10.8.0/";

const ASSETS = [
  "./", "./index.html", "./admin.html", "./style.css",
  "./app.js", "./admin.js", "./utils.js", "./firebase-config.js",
  "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png"
];
const SDK_ENTRIES = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js", "firebase-storage.js"].map((f) => SDK_ROOT + f);

// Télécharge un module du SDK et, récursivement, ceux qu'il importe.
async function precacheSdk(url, cache, seen = new Set()) {
  if (seen.has(url)) return;
  seen.add(url);
  const res = await fetch(url);
  if (!res.ok) return;
  await cache.put(url, res.clone());
  const text = await res.text();
  for (const m of text.matchAll(/(?:from|import)\s*["']([^"']+\.js)["']/g)) {
    let next;
    try { next = new URL(m[1], url).href; } catch { continue; }
    if (next.startsWith(SDK_ROOT)) await precacheSdk(next, cache, seen);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const staticCache = await caches.open(STATIC_CACHE);
    await staticCache.addAll(ASSETS);
    try {
      const sdkCache = await caches.open(SDK_CACHE);
      const seen = new Set();
      for (const url of SDK_ENTRIES) await precacheSdk(url, sdkCache, seen);
    } catch (e) { /* hors-ligne pendant l'installation : le cache d'exécution complétera */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("homelies-static-") && k !== STATIC_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req);
  const network = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await network) || Response.error();
}

async function networkFirstPage(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match("./index.html")) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (req.url.startsWith(SDK_ROOT)) return event.respondWith(cacheFirst(req, SDK_CACHE));
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // Firestore, Auth, Storage, médias : laissés au navigateur
  if (req.mode === "navigate") return event.respondWith(networkFirstPage(req));
  event.respondWith(staleWhileRevalidate(req));
});
