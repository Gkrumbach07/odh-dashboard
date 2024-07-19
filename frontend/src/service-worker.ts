const CACHE_NAME = 'api-cache';

const cachedRequests: { matcher: RegExp; maxAge: number }[] = [
  {
    matcher: /\/api\/service\/pipelines\/[^/]+\/dspa\/apis\/v2beta1\/experiments\/[^?].*/,
    maxAge: 60000,
  },
];

const inFlightRequests = new Map<
  string,
  { promise: Promise<Response>; controller: AbortController }
>();

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
    const controller = new AbortController();
    const fetchPromise = fetchAndUpdateCache(request, controller.signal);
    inFlightRequests.set(url, { promise: fetchPromise, controller });

    fetchPromise
      .catch((error) => {
        // Handle fetch errors by deleting from in-flight requests
        inFlightRequests.delete(url);
        throw error;
      })
      .finally(() => inFlightRequests.delete(url));
  }

  const { promise, controller } = inFlightRequests.get(url)!;

  // Listen to the original request's abort signal
  request.signal.addEventListener('abort', () => {
    if (!controller.signal.aborted) {
      // Remove from in-flight requests if the original request was aborted
      if (inFlightRequests.has(url)) {
        inFlightRequests.delete(url);
        // Reject the promise that we returned for the request
        promise.catch(() => {}); // suppress unhandled promise rejection warning
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
    }
  });

  console.log('in flight --> redirecting');

  return promise;
}

async function fetchAndUpdateCache(request: Request, signal: AbortSignal): Promise<Response> {
  console.log('update cache');
  const response = await fetch(request, { signal });
  if (!response.ok) {
    throw new Error('Network response was not ok');
  }
  const cache = await caches.open(CACHE_NAME);
  cache.put(request.url, response.clone());
  return response;
}
