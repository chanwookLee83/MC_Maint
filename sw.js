// Firebase Messaging compat (백그라운드 FCM 수신용)
importScripts('https://www.gstatic.com/firebasejs/12.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAaqbae8isyjMsCbO7mhPjQSI0DlBwJ_Sk",
  authDomain: "maintenance-app-3632e.firebaseapp.com",
  projectId: "maintenance-app-3632e",
  storageBucket: "maintenance-app-3632e.firebasestorage.app",
  messagingSenderId: "678083184973",
  appId: "1:678083184973:web:fdee29ea69f1161b204f04"
});

const messaging = firebase.messaging();

// 앱이 백그라운드일 때 FCM 메시지 수신 → OS 알림 표시
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  const data = payload.data || {};
  return self.registration.showNotification(title || '설비 알림', {
    body: body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: data
  });
});

// 알림 클릭 → 의뢰 알림이면 의뢰 탭으로 이동
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || null;
  const targetUrl = tab ? './?tab=' + tab : './';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length > 0) {
        const client = list[0];
        // 앱이 이미 열려 있으면 메시지로 탭 이동 지시
        if (tab) client.postMessage({ type: 'GOTO_TAB', tab });
        return client.focus();
      }
      // 앱이 닫혀 있으면 URL 파라미터로 열기
      return clients.openWindow(targetUrl);
    })
  );
});

// 페이지에서 직접 알림 요청 처리 (클라이언트 사이드 스케줄러용)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      self.registration.showNotification(event.data.title, {
        body: event.data.body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        vibrate: [200, 100, 200],
        tag: event.data.tag || 'mms-scheduled',
        data: event.data.notifData || {}
      })
    );
  }
});

// ── 캐시 (버전 올림) ──
const CACHE = 'mms-v75';
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
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('gstatic.com') ||
      url.includes('googleapis.com')) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
