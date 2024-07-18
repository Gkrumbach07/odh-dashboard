const CACHE_NAME = 'api-cache';

const cachedRequests: { matcher: RegExp; maxAge: number }[] = [
  {
    matcher: /\/api\/service\/pipelines\/.*\/dspa\/apis\/v2beta1\/experiments\/[^?].*/,
    maxAge: 10,
  },
];

self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;
  const match = cachedRequests.find((cachedRequest) => cachedRequest.matcher.test(request.url));
  if (match) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          const cachedTime = cachedResponse.headers.get('Date')
            ? new Date(cachedResponse.headers.get('Date')!).getTime()
            : null;
          const now = new Date().getTime();

          const { maxAge } = match;

          if (maxAge && cachedTime && now - cachedTime > maxAge) {
            return fetchAndUpdateCache(request);
          }
          return cachedResponse;
        }
        return fetchAndUpdateCache(request);
      }),
    );
  } else {
    event.respondWith(fetch(request));
  }
});

async function fetchAndUpdateCache(request: Request): Promise<Response> {
  const response = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  cache.put(request.url, response.clone());
  return response;
}
