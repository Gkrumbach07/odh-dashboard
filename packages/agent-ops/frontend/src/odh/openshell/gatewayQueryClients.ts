import { QueryClient } from '@tanstack/react-query';

/**
 * One react-query cache per gateway.
 *
 * The openshell-dashboard package builds query keys out of resource names only
 * (`['sandboxes', workspace, …]`) with no gateway dimension, so two gateways
 * that each have a workspace called "default" would read each other's entries
 * out of a shared cache. Giving each gateway its own client isolates them
 * without teaching the package about gateways.
 *
 * The map is keyed by gateway id, and ids are reused: discovery derives them
 * from an operator-supplied annotation (or namespace/name), so an install can
 * be deleted and a *different* install can appear later under the same id. That
 * makes eviction part of the isolation, not just housekeeping — a cache left
 * behind would be served to whatever next claims the id.
 */
const queryClients = new Map<string, QueryClient>();

export const queryClientFor = (gatewayId: string): QueryClient => {
  const existing = queryClients.get(gatewayId);
  if (existing) {
    return existing;
  }
  const created = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
    },
  });
  queryClients.set(gatewayId, created);
  return created;
};

/**
 * Drops a gateway's cache once it is neither discovered nor on screen. Called
 * alongside forgetGateway, so a gateway's cached resources never outlive the
 * session and token that were allowed to read them.
 */
export const releaseQueryClient = (gatewayId: string): void => {
  const existing = queryClients.get(gatewayId);
  if (!existing) {
    return;
  }
  queryClients.delete(gatewayId);
  // Empties both caches; anything still in flight is abandoned with it.
  existing.clear();
};
