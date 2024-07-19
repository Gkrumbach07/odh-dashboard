const CACHE_NAME = 'api-cache';

const cachedRequests: { matcher: RegExp; maxAge: number }[] = [
  {
    matcher: /\/api\/service\/pipelines\/[^/]+\/dspa\/apis\/v2beta1\/experiments\/[^?].*/,
    maxAge: 60000,
  },
];

const inFlightRequests = new Map<string, Promise<Response>>();

self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;
  const match = cachedRequests.find((cachedRequest) => cachedRequest.matcher.test(request.url));
  if (match) {
    event.respondWith(handleCacheRequest(request, match.maxAge));
  } else {
    event.respondWith(fetch(request));
  }
});

async function handleCacheRequest(request: Request, maxAge: number): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    console.log('cache hit');

    const cachedTime = cachedResponse.headers.get('Date')
      ? new Date(cachedResponse.headers.get('Date')!).getTime()
      : null;
    const now = new Date().getTime();

    if (maxAge && cachedTime && now - cachedTime > maxAge) {
      console.log('cache expired');
      return getOrCreateFetch(request);
    }
    return cachedResponse;
  }
  console.log('cache miss');
  return getOrCreateFetch(request);
}

async function getOrCreateFetch(request: Request): Promise<Response> {
  const { url } = request;

  if (!inFlightRequests.has(url)) {
    const fetchPromise = fetchAndUpdateCache(request);
    inFlightRequests.set(url, fetchPromise);
    fetchPromise
      .catch((error) => {
        // Handle fetch errors by deleting from in-flight requests
        inFlightRequests.delete(url);
        throw error;
      })
      .finally(() => inFlightRequests.delete(url));
  }

  console.log('in flight --> redirecting');

  return inFlightRequests.get(url)!;
}

async function fetchAndUpdateCache(request: Request): Promise<Response> {
  console.log('update cache');
  const response = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  cache.put(request.url, response.clone());
  return response;
}
