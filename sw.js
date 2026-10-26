// 오프라인에서도 화면이 뜨도록 앱 파일을 캐시해 둡니다.
// 기록 내용은 캐시하지 않습니다 (브라우저 저장소에만 있습니다).

const VERSION = "v7";
const CACHE = `carefor-${VERSION}`;

const ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./js/main.js",
  "./js/api.js",
  "./js/backend.js",
  "./js/prompts.js",
  "./js/store.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 한 파일이 실패해도 설치 전체가 실패하지 않도록 개별로 담습니다.
      .then((cache) =>
        Promise.all(
          ASSETS.map((url) =>
            cache.add(url).catch(() => {
              /* 이 파일은 다음 요청 때 네트워크에서 가져옵니다 */
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // API 호출과 외부 스크립트는 캐시하지 않고 그대로 네트워크로 보냅니다.
  if (url.origin !== self.location.origin) return;

  // 앱 파일은 네트워크를 먼저 시도하고, 실패하면 캐시로 돌아갑니다.
  // 이렇게 해야 배포한 수정분이 바로 반영됩니다.
  event.respondWith(
    // GitHub Pages 는 파일을 10분간 캐시하라고 하므로, 그대로 두면 index.html 은 새것인데
    // main.js 는 옛것인 식으로 어긋날 수 있습니다. 항상 서버에 바뀌었는지 묻습니다(ETag).
    fetch(request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => {
          if (hit) return hit;
          // 화면 이동만 index.html 로 대신합니다. 스크립트·스타일이 빠졌을 때 HTML 을 돌려주면
          // 알 수 없는 오류로 보이기 때문입니다.
          if (request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
