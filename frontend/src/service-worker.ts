/* eslint-disable no-console */
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
    promise: Promise<void>;
    resolvers: { resolve: (value: Response) => void; reject: (reason?: unknown) => void }[];
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
    console.log('creating new fetch request');

    const fetchPromise = fetch(request, { signal: new AbortController().signal })
      .then(async (response) => {
        console.log('resolving promise');
        const cache = await caches.open(CACHE_NAME);
        cache.put(request.url, response.clone());
        resolvers.forEach(({ resolve }) => resolve(response));
      })
      .catch((error) => {
        console.log('rejecting promise');
        resolvers.forEach(({ reject }) => reject(error));
      })
      .finally(() => {
        console.log('fetch complete');
        inFlightRequests.delete(url);
      });

    inFlightRequests.set(url, { promise: fetchPromise, resolvers: [] });
  }

  const { resolvers } = inFlightRequests.get(url)!;
  console.log('adding new promise to resolvers', inFlightRequests.get(url));

  const newPromise = new Promise<Response>((resolve, reject) => {
    resolvers.push({ resolve, reject });
  });

  request.signal.addEventListener('abort', () => {
    console.log('aborting event');
    if (inFlightRequests.has(url)) {
      const { resolvers: abortResolvers } = inFlightRequests.get(url)!;
      console.log('aborting fetch request from resolvers with length', abortResolvers.length);
      abortResolvers.splice(0, 1);
    }
  });

  return newPromise;
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
