# OpenShell gateway discovery

How RHOAI finds the OpenShell installs it fronts, and why most of it is not
configured in RHOAI at all.

## The problem it solves

An OpenShell gateway rejects a token whose `issuer` or `audience` does not match
what the gateway itself was started with. Both values live in the gateway's Helm
values, and the browser needs both to run the OIDC flow — so the dashboard needs
them too.

The obvious way to get them there is to write them into RHOAI's config. That
creates a second copy of a value whose original lives somewhere else, and nothing
validates the copy against the original. When they drift, the only symptom is the
gateway refusing a token several hops away, with nothing earlier in the chain
reporting a problem.

Discovery removes the copy. The dashboard reads `issuer` and `audience` out of the
gateway's own ConfigMap, so there is no second value that can disagree.

## What is discovered and what is configured

| Value | Source | Can it drift? |
|---|---|---|
| which gateways exist | Services labelled `app.kubernetes.io/name=openshell` | no |
| gRPC endpoint | the Service's `grpc` port + cluster DNS | no |
| `issuer` | the gateway's ConfigMap, `[openshell.gateway.oidc]` | no |
| `audience` | the gateway's ConfigMap, `[openshell.gateway.oidc]` | no |
| `clientId` | annotation on the Service | n/a — see below |
| display name, console URL, scope | annotations on the Service | n/a |

`clientId` is the one thing discovery cannot close, and that is a property of
OpenShell rather than a gap here. The gateway's `[openshell.gateway.oidc]` table
carries `issuer` and `audience` only: the gateway validates tokens, it does not
issue them, so it has no notion of a browser OIDC client. `clientId` belongs to
whoever runs the browser flow.

It also cannot drift *against the gateway* for the same reason — the gateway never
sees it. A wrong `clientId` fails at the IdP, at the start of the flow, where the
error names the problem. That is a much better failure than a wrong `audience`.

## Setting up a gateway for discovery

The gateway's Service needs one annotation. Everything else is optional.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: openshell
  namespace: openshell
  labels:
    app.kubernetes.io/name: openshell        # set by the OpenShell chart
  annotations:
    openshell.opendatahub.io/client-id: openshell-dashboard
    openshell.opendatahub.io/display-name: Production
    openshell.opendatahub.io/console-url: https://openshell.apps.example.com
```

A cluster with one IdP can set `openshell-client-id` once in the dashboard's
params instead, and annotate only the gateways that differ.

### All annotations

| Annotation | Purpose |
|---|---|
| `client-id` | **Required.** The browser's OIDC public client for this gateway. |
| `display-name` | What the gateway switcher shows. Defaults to the id. |
| `console-url` | Links out to the standalone console for what the embedding cannot carry (the terminal). |
| `scope` | OIDC scopes. Defaults to the dashboard's `openshell-scope`. |
| `id` | Overrides the derived id. See the warning below. |
| `config-map` | Names the ConfigMap holding `gateway.toml` when it is not `<service>-config`. |
| `issuer`, `audience` | Override what the gateway's ConfigMap says. **Re-opens the drift hole** — for when the ConfigMap is unreadable, not for normal configuration. |
| `ignore: "true"` | Excludes a matching Service from the fleet. |

### Gateway ids

The id is derived as `<namespace>-<name>`, collapsed to `<name>` when they match
(so a release called `openshell` in namespace `openshell` gets the id `openshell`).

It depends only on that gateway's own coordinates, deliberately. The id is a URL
path segment **and** it keys the browser's stored OIDC session for that gateway, so
changing it signs everyone out of that gateway. An id derived from anything global
— "use the bare name while it happens to be unique" — would rename an existing
gateway the moment a second one appeared.

Use the `id` annotation only to *preserve* an id already in use.

## Dashboard configuration

| Param | Meaning |
|---|---|
| `openshell-discovery` | `true` to discover from the cluster. |
| `openshell-client-id` | Default browser OIDC client for gateways that do not annotate their own. |
| `openshell-gateway-selector` | Label selector. Empty uses the chart's own label. |
| `openshell-gateway-namespaces` | Comma-separated namespaces. Empty searches the cluster. |
| `openshell-gateways` | Explicit JSON list. **Disables discovery.** |

`openshell-gateways` wins over discovery on purpose: a developer pointing at a
gateway on a laptop, or an operator pinning an install the selector does not match,
needs a way to say so that discovery cannot override. It also brings the
hand-copied `issuer`/`audience` back, so prefer discovery in a cluster.

## RBAC

The dashboard's service account needs, cluster-wide:

- `services`: `get`, `list`, `watch`
- `configmaps`: `get`

There is deliberately no `list` on ConfigMaps. With `get` only, the dashboard can
read a ConfigMap whose exact name it derived from a gateway Service it already
found, and cannot enumerate anything else. To narrow further, set
`openshell-gateway-namespaces` and move both rules into a `Role` in each of them.

## Behaviour

- **Resync** every 2 minutes, so a gateway installed or removed after startup is
  picked up without restarting the dashboard.
- **A source error keeps the current fleet.** "I could not tell" is not "there are
  none" — a transient API server error must not disconnect every user from every
  working gateway.
- **An empty cluster is not a startup error.** The operator may not have installed
  a gateway yet.
- **A gateway that cannot be fully resolved is still listed**, marked
  not-connectable with the reason. A gateway with an unreadable ConfigMap silently
  vanishing from the switcher would be much harder to diagnose.
- **A changed gateway is rebuilt.** The embedded BFF bakes the OIDC config in at
  construction, so a gateway whose issuer changes gets a new one — otherwise the
  dashboard would keep handing the browser an issuer the gateway no longer accepts,
  which is the failure this whole mechanism exists to prevent.

## Not covered

Discovery finds gateways; it does not decide who may use one. Every gateway listed
by `/openshell/gateways` is visible to any RHOAI user who can reach the Agents
area, and authorization happens at the gateway, against the OpenShell token. A user
who cannot sign in to a gateway's IdP sees it listed and fails at Connect.
