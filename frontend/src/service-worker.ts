const CACHE_NAME = 'api-cache';

const cachedRequests: { matcher: RegExp; maxAge: number }[] = [
  {
    matcher: /\/api\/service\/pipelines\/[^/]+\/dspa\/apis\/v2beta1\/experiments\/[^?].*/,
    maxAge: 60000,
  },
];

const inFlightRequests = new Map<
  string,
  {
    promise: Promise<Response>;
    controller: AbortController;
    resolvers: { resolve: Function; reject: Function }[];
  }
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
    const cachedTime = cachedResponse.headers.get('Date')
      ? new Date(cachedResponse.headers.get('Date')!).getTime()
      : null;
    const now = new Date().getTime();

    if (maxAge && cachedTime && now - cachedTime > maxAge) {
      console.log('cache expired');
      return getOrCreateFetch(request);
    }
    console.log('cache hit');
    return cachedResponse;
  }
  console.log('cache miss');
  return getOrCreateFetch(request);
}

async function getOrCreateFetch(request: Request): Promise<Response> {
  const { url } = request;

  if (!inFlightRequests.has(url)) {
    const controller = new AbortController();

    const fetchPromise = fetchAndUpdateCache(request, controller.signal).finally(() => {
      inFlightRequests.delete(url);
    });

    inFlightRequests.set(url, { promise: fetchPromise, controller, resolvers: [] });
  }

  const { promise, controller, resolvers } = inFlightRequests.get(url)!;

  const newPromise = new Promise<Response>((resolve, reject) => {
    resolvers.push({ resolve, reject });
  });

  request.signal.addEventListener('abort', () => {
    console.log('abort', controller.signal);
    if (!controller.signal.aborted) {
      if (inFlightRequests.has(url)) {
        const { resolvers: abortResolvers } = inFlightRequests.get(url)!;
        abortResolvers.forEach(({ reject }) => {
          reject(new DOMException('The user aborted a request.', 'AbortError'));
        });
        inFlightRequests.delete(url);
      }
    }
  });

  promise
    .then((response) => {
      resolvers.forEach(({ resolve }) => resolve(response));
    })
    .catch((error) => {
      resolvers.forEach(({ reject }) => reject(error));
    });

  return newPromise;
}

async function fetchAndUpdateCache(request: Request, signal: AbortSignal): Promise<Response> {
  const response = await fetch(request, { signal });
  if (!response.ok) {
    throw new Error('Network response was not ok');
  }
  const cache = await caches.open(CACHE_NAME);
  cache.put(request.url, response.clone());
  return response;
}

/**
 * 
 req1 -> check cache -> miss -> create promise -> add promise to inflight cache -> create fetch -> on fetch success resolve promise
     -> abort -> reject promise, leave fetch alone

req2 -> check cache -> hit -> return cache
                    -> inflight -> create promise -> add promise to inflight cache -> wait for fetch promise -> resolve all inflight promises
     -> abort -> reject promise
---
async -> fetch success -> add to cache -> resolve all inflight promises -> delete inflight promises
      -> fetch failed -> reject all inflight promises -> delete inflight promises
 */
