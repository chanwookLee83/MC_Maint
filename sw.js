const CACHE = 'mms-v43';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Firebase, Google 외부 요청은 캐시 무시하고 네트워크로 직접
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('gstatic.com') ||
      url.includes('googleapis.com')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // 내부 파일만 캐시 사용
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

