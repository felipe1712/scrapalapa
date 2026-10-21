var static = "WinDOORS";
var cacheassets = [
    'assets/img/bg-1.jpg',
    'assets/img/bg-2.jpg',
    'assets/img/bg-3.jpg',
    'assets/img/bg-4.jpg',
    'assets/img/bg-5.jpg',
    'assets/img/bg-6.jpg',
    'assets/img/bg-7.jpg',
    'assets/img/bg-8.jpg',
    'assets/img/bg-9.jpg',
    'assets/img/bg-10.jpg',
];

self.addEventListener("install", function (event) {
    event.waitUntil(
        caches.open(static).then(function (cache) {
            cache.addAll(cacheassets);
        }).then(function () {
            return self.skipWaiting();
        })
    );
});
self.addEventListener("activate", function (event) { });

self.addEventListener("fetch", function (event) {
    event.respondWith(
        caches.match(event.request).then(function (response) {
            return response || fetch(event.request)
        })
    );
});