# fleet

Fronts a set of externally-deployed backend services from a single dashboard module BFF.

The module-federation proxy maps **one path to one service**. That is enough while a
module fronts a single external gateway, and stops working the moment it fronts
several — you need per-request target selection, per-backend discovery, and a place
to swap credentials. That is this package.

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
| `DiscoverFunc[D]` — how a backend describes itself | `GET /api/v1/auth/config` → issuer, clientId, audience |
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
- **Router** — `/{prefix}/{id}/...` to the right backend, one cached reverse proxy
  each, with hooks for the credential swap and response mapping.
