{
  "name": "Maintenance History",
  "short_name": "Maintenance",
  "description": "설비 정비이력 / 부품재고 / MTBF·MTTR 관리",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#0a0c0f",
  "theme_color": "#f59e0b",
  "orientation": "portrait",
  "icons": [
    {
      "src": "icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}

const CACHE = 'mms-v25';
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

