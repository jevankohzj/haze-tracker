/* Haze Tracker service worker: offline app shell, background alert checks, notification clicks. */
importScripts('core.js');

var CACHE = 'haze-tracker-v1';
var SHELL = [
  './',
  'index.html',
  'styles.css',
  'core.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

// App files: serve from cache straight away, refresh the cache in the background.
// Data requests (/api and NEA) are never intercepted, so readings are always live.
self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (cached) {
        var network = fetch(req)
          .then(function (res) {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(function () { return cached || (req.mode === 'navigate' ? cache.match('index.html') : undefined); });
        return cached || network;
      });
    })
  );
});

// Chrome on Android can wake an installed app now and then to run this check.
self.addEventListener('periodicsync', function (event) {
  if (event.tag === 'haze-check') {
    event.waitUntil(HazeCore.runCheck(self.registration).catch(function () {}));
  }
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
