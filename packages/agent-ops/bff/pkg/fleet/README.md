# fleet

Fronts a set of externally-deployed backend services from a single dashboard module BFF.

The module-federation proxy maps **one path to one service**, and a module declares
exactly one such entry (agent-ops: `/agent-ops/api` → `/api`). That is enough while a
module fronts a single external gateway, and stops working the moment it fronts
several — you need per-request target selection, per-backend discovery, and a place
to swap credentials, all *behind* that single path. That is this package.

## Why it is separate

`agent-ops` uses it to route to OpenShell installs. It is written to be lifted
as-is by any other module with the same shape — most likely **MaaS**, which today
fronts one gateway with runtime discovery (`DiscoverMaasApiURL`, a background retry
loop, a readiness gate) and will hit the identical fan-out problem if its AI gateway
becomes multi-tenant.

Nothing here knows about OpenShell, RHOAI, or any domain type. It depends only on
the standard library.

## To extract

Move this directory into a shared module and update the import path. Nothing else.
The OpenShell-specific half lives in `internal/api/openshell_*.go` and is the model
for what a consumer supplies:

| Consumer supplies | OpenShell's version |
|---|---|
| `DiscoverFunc[D]` — how a backend describes itself | `GetGatewayInfo` over gRPC → version, status, drivers |
| membership — which backends exist | Services carrying the OpenShell chart's label |
| `Router.Rewrite` — the credential swap | RHOAI token destroyed, OpenShell token projected on |
| `Router.OnResponse` — status mapping | 401 → `gateway_auth_required`, 403 → `gateway_forbidden` |
| `Router.Codes` — error codes | `gateway_*`, so the frontend contract stays stable |

## What it gives you

- **Registry** — parse and validate a JSON fleet, cache each backend's discovery
  document with a TTL, and keep the last good copy when a refresh fails so one
  flaky fetch cannot take a working backend out of service.
- **Readiness** — a backend that has never been discovered is held out of service
  and returns an honest "not ready" instead of a transport error.
- **Background retry** — `Start` discovers asynchronously with exponential backoff,
  so a backend that is down at boot heals on its own and startup is never blocked.
- **Router** — `/{prefix}/{id}/...` to the right backend, one cached handler
  each, with a hook for the credential swap. `Prefix` is trimmed literally rather
  than segment-wise, so it can be multi-segment: agent-ops mounts the fleet at
  `/api/openshell`, inside its own module proxy prefix, not at the root.
- **Dynamic membership** — `SetBackends` swaps the fleet's roster while it is
  serving. Backends that survive keep their cached discovery document and their
  readiness, so a resync never briefly takes a working backend out of service.
  Pair it with `Options{Dynamic: true}`, which keeps the background retry loop
  alive after the fleet first goes green — otherwise a backend added later is
  never retried, because the loop that would have retried it has exited.
- **Handler invalidation** — `Router.Forget(ids...)` drops cached handlers. The
  cache is keyed by backend ID, and an ID outlives what it points at: a
  rediscovered backend may have a new URL, or new credentials baked into an
  embedded handler. Forget it on every change or the router keeps serving the
  handler built for the old configuration.

## Configured vs discovered fleets

A fleet told what its members are cannot be wrong about them; a fleet that asks
has to decide what a failed question means. The rule this package assumes, and
that `agent-ops` implements above it:

- **source error** → "I could not tell." Keep the fleet as it is. A transient API
  server error must not tear down every working backend.
- **empty answer, no error** → "there are genuinely none." Empty the fleet.

The same split is why `SetBackends` returns what changed rather than swapping
silently: the consumer needs those IDs to invalidate its own caches.

## Proxying vs embedding

The Router supports both, and the choice is one field:

| | `Handlers` unset | `Handlers` set |
|---|---|---|
| target | reverse-proxies to `Backend.URL` | dispatches to an in-process `http.Handler` |
| needs | a service per backend | nothing — the backend's handler is imported |
| use when | the backend is only reachable over the network | the backend ships an importable handler |

agent-ops uses the embedded form: it imports the upstream OpenShell BFF and
mounts one App per gateway, so there is no relay service per gateway and no
extra network hop. `Backend.URL` is then unused and left empty.

Note that response rewriting (`OnResponse`) only applies to the proxied form —
an embedded handler writes straight to the `ResponseWriter`, so a consumer that
needs to remap statuses wraps its handler instead.
