import { BFF_API_VERSION, URL_PREFIX } from './const';

// ─── Browser routes ──────────────────────────────────────────────────────────
// Where the SPA router mounts things. Never reverse-proxied: a path here is
// resolved by the browser, so it must not collide with the BFF URLs below.

export const agentsRootPath = '/ai-hub/agents';
export const agentDeploymentsPath = `${agentsRootPath}/deployments`;

/**
 * Root of the gateway-scoped subtree. Everything below it names exactly one
 * discovered gateway, because a gateway is the only axis left: which install
 * you are looking at.
 */
export const gatewaysPath = `${agentDeploymentsPath}/gateways`;

/**
 * A gateway's own page. The id is the same wire key used everywhere else — the
 * BFF's tunnel subtree (see `openShellGatewayApiBasePath`), the client base
 * path, and the per-gateway OIDC storage prefix — so putting it in the URL
 * makes the URL the single source of truth for which gateway is mounted,
 * instead of a re-derived guess.
 *
 * Ids come from an operator-supplied annotation and are not guaranteed to be
 * path-safe, so they are encoded here and decoded by the router's params.
 */
export const gatewayRoute = (gatewayId: string): string =>
  `${gatewaysPath}/${encodeURIComponent(gatewayId)}`;

/**
 * A sandbox inside one gateway's workspace. The gateway id leads, because a
 * workspace name is only unique within a gateway: two installs each with a
 * workspace called "default" would otherwise produce byte-identical URLs and a
 * bookmark would silently open the wrong install's sandbox.
 */
export const openShellSandboxRoute = (
  gatewayId: string,
  workspace: string,
  sandbox: string,
  tab?: string,
): string =>
  `${gatewayRoute(gatewayId)}/workspaces/${encodeURIComponent(
    workspace,
  )}/sandboxes/${encodeURIComponent(sandbox)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`;

/**
 * Where an OpenShell gateway's IdP sends the browser back to.
 *
 * These are the same two paths `openShellAuth` stamps into every UserManager's
 * `redirect_uri`/`silent_redirect_uri`, spelled here as well because the
 * standalone router has to register them and importing them from openShellAuth
 * would drag `oidc-client-ts` into the entry chunk for two strings. The copy is
 * pinned to the original by `__tests__/routes.spec.ts`, which fails if either
 * side moves — a drifted redirect URI is one no IdP has been told about, and it
 * fails at the IdP with no diagnostic in our own logs.
 *
 * Both must stay OUTSIDE `proxiedBffPathPrefix` (declared below; asserted by
 * `__tests__/routes.spec.ts` and `src/odh/__tests__/extensions.spec.ts`): under
 * it they would be reverse-proxied to the BFF carrying the IdP's authorization
 * code, and the sign-in they exist to complete would never run in the browser.
 */
export const oidcCallbackPath = `${agentsRootPath}/oidc/callback`;
export const oidcSilentCallbackPath = `${agentsRootPath}/oidc/silent-callback`;

// ─── BFF URLs ────────────────────────────────────────────────────────────────
// Where the browser reaches this module's BFF. Everything the module sends to
// its BFF lives under ONE prefix, because the module declares exactly one
// module-federation proxy entry: { path: '/agent-ops/api', pathRewrite: '/api' }.
// The dashboard strips `${URL_PREFIX}/api` on the way through, so the BFF sees
// `/api/...`.

/**
 * The proxied prefix. Derived from URL_PREFIX rather than spelled out as
 * '/agent-ops/api' because mod-arch-core builds every other BFF URL this module
 * issues the same way — `${URL_PREFIX}/api/${BFF_API_VERSION}/...`, with no
 * deployment-mode branch — so a second, hardcoded copy could drift away from the
 * proxy entry that actually carries the traffic, and the drift would surface
 * only as a 404 at runtime.
 *
 * It is also the prefix SPA routes must stay OUT of: anything under it is
 * reverse-proxied to the BFF and never reaches the browser's router. The OIDC
 * callback routes depend on that (see openShellAuth.OIDC_CALLBACK_PATH).
 */
export const proxiedBffPathPrefix = `${URL_PREFIX}/api`;

/**
 * The OpenShell gateway registry — which installs this cluster has, and the
 * public OIDC metadata for each.
 *
 * This endpoint is OURS: versioned, and in the agent-ops OpenAPI spec, so it
 * sits under `/api/${BFF_API_VERSION}` like every other endpoint this module
 * owns. Browser `/agent-ops/api/v1/openshell/gateways` → BFF
 * `/api/v1/openshell/gateways`.
 *
 * DO NOT "tidy" this into a path derived from `openShellGatewayApiBasePath`'s
 * prefix. The two live under different parents on purpose (see below); derived
 * from the tunnel prefix this becomes `/api/openshell/gateways`, which the
 * tunnel mount swallows and answers as a request for the gateway whose id is
 * "gateways" — a silent wrong answer, not an error.
 */
export const openShellGatewayRegistryUrl = `${proxiedBffPathPrefix}/${BFF_API_VERSION}/openshell/gateways`;

/**
 * Base path for one gateway's tunnel: the openshell-dashboard client hangs the
 * gateway's OWN API off this, and the BFF splits the id back off and dispatches
 * to that gateway's embedded App.
 *
 * Deliberately UNversioned — `/api/openshell/{id}`, not `/api/v1/openshell/{id}`
 * — because everything past the id is the gateway's API, not ours. Stamping a
 * RHOAI API version onto someone else's contract would claim a compatibility
 * promise we do not make and cannot keep.
 *
 * The id is not encoded: it is the literal wire key the BFF's router splits back
 * out of the path, and it is the same value used for the SPA route, the OIDC
 * storage prefix and the token header scope.
 */
export const openShellGatewayApiBasePath = (gatewayId: string): string =>
  `${proxiedBffPathPrefix}/openshell/${gatewayId}`;
