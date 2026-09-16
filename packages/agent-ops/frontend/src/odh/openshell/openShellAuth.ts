import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { agentsRootPath, gatewayRoute } from '~/app/utilities/routes';

/**
 * Browser-side OpenShell authentication for the RHOAI embedding.
 *
 * Every OpenShell gateway is its own identity domain. The RHOAI/OpenShift token
 * authenticates the user to RHOAI and stops at the dashboard's OpenShell router;
 * to reach a gateway the browser signs in to THAT gateway's OIDC provider and
 * sends the resulting token on a dedicated header, scoped to that gateway alone.
 *
 * Nothing here is a singleton: sessions, managers and connection state are all
 * keyed by gateway id, so a user can be connected to several gateways at once.
 * Only the *rendered* gateway is one at a time (see OpenShellConnection).
 */

export type OpenShellConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'unconfigured';

export type OpenShellConnectionState = {
  status: OpenShellConnectionStatus;
  username: string | null;
  error: string | null;
};

/**
 * One OpenShell install as the router describes it. Identity fields come from
 * that gateway's own public /api/v1/auth/config — the dashboard never hardcodes
 * an issuer, so the value that mints a token and the value that validates it
 * cannot drift apart.
 */
export type OpenShellGateway = {
  id: string;
  name: string;
  consoleUrl?: string;
  issuer?: string;
  clientId?: string;
  audience?: string;
  scope?: string;
  /**
   * Version the gateway reports for itself. Named for the wire field the router
   * serializes (`gatewayVersion`) — it is the gateway's version, not an API
   * version, and reading it under any other name silently yields undefined.
   */
  gatewayVersion?: string;
  features: Record<string, boolean>;
  /**
   * Whether this deployment's configuration can mint a token this gateway will
   * accept. A fact about cluster configuration — never about whether *this user*
   * has signed in, which is what the connection state says.
   */
  connectable: boolean;
  /** Why `connectable` is false. Only meaningful alongside `connectable: false`. */
  error?: string;
  /**
   * A configuration the router believes will fail at the gateway but cannot
   * prove wrong from here — typically an audience that is not requested in the
   * scope. Deliberately does not gate `connectable`, so a gateway can be fully
   * usable and still carry one; surface it, never block on it.
   */
  warning?: string;
};

/**
 * Outcome of asking the router for the gateway registry. A cluster with no
 * OpenShell discovery configured is not a failure — the router disables the
 * whole `/openshell` subtree and answers 404 — so it gets its own variant
 * rather than being reported as a broken request.
 */
export type GatewayRegistrySnapshot =
  | { status: 'ok'; gateways: OpenShellGateway[] }
  | { status: 'not-configured' }
  | { status: 'error'; message: string };

/**
 * Dedicated request header that carries the OpenShell token from the browser to
 * the dashboard's OpenShell router. RHOAI's data-science-gateway ext-authz
 * (kube-auth-proxy) rewrites `Authorization` and `x-forwarded-access-token` to the
 * platform's own OpenShift token, so the OpenShell token cannot ride either — it
 * travels on this custom header (passed through untouched) and the router
 * translates it into the relay's x-forwarded-access-token.
 * Must match OpenShellAuthHeader in openshell_handler.go.
 */
export const OPENSHELL_AUTH_HEADER = 'X-OpenShell-Authorization';

/** Emitted by the OpenShell package's session-expired handler, per gateway. */
export const OPENSHELL_SESSION_EXPIRED_EVENT = 'openshell:session-expired';

// Shared with the route builders rather than re-declared: the callback paths
// below are derived from it, and a second copy that drifted would register
// redirect URIs no IdP has ever been told about.
const AGENTS_ROOT = agentsRootPath;
/**
 * Callback routes are registered as SPA routes OUTSIDE the /openshell/* prefix
 * (which is reverse-proxied to the BFF) so they resolve in the browser. One path
 * serves every gateway; the gateway being completed is carried in sessionStorage
 * and cross-checked against the OIDC `state`, so each gateway's IdP only needs
 * this single redirect URI registered.
 */
export const OIDC_CALLBACK_PATH = `${AGENTS_ROOT}/oidc/callback`;
export const OIDC_SILENT_CALLBACK_PATH = `${AGENTS_ROOT}/oidc/silent-callback`;

const PENDING_GATEWAY_KEY = 'openshell.pending-gateway';
const RETURN_TO_KEY = 'openshell.return-to';

type Listener = (state: OpenShellConnectionState) => void;

const managers = new Map<string, UserManager>();
const gateways = new Map<string, OpenShellGateway>();
const states = new Map<string, OpenShellConnectionState>();
const listeners = new Map<string, Set<Listener>>();
/** In-flight initConnection calls, so several surfaces can seed the same gateway. */
const initInFlight = new Map<string, Promise<void>>();

const IDLE: OpenShellConnectionState = { status: 'idle', username: null, error: null };

export const getConnectionState = (gatewayId: string): OpenShellConnectionState =>
  states.get(gatewayId) ?? IDLE;

const setState = (gatewayId: string, next: Partial<OpenShellConnectionState>): void => {
  const current = getConnectionState(gatewayId);
  const merged = { ...current, ...next };
  // Discovery is polled, so the same state is re-derived on a regular tick. A
  // no-op write would still hand every subscriber a fresh object and re-render
  // the tree, so identical states are dropped here rather than in each consumer.
  if (
    states.has(gatewayId) &&
    merged.status === current.status &&
    merged.username === current.username &&
    merged.error === current.error
  ) {
    return;
  }
  states.set(gatewayId, merged);
  listeners.get(gatewayId)?.forEach((listener) => listener(merged));
};

export const subscribeConnection = (gatewayId: string, listener: Listener): (() => void) => {
  const set = listeners.get(gatewayId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(gatewayId, set);
  listener(getConnectionState(gatewayId));
  return () => {
    set.delete(listener);
  };
};

const readSession = (key: string): string | null => {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeSession = (key: string, value: string | null): void => {
  try {
    if (value === null) {
      window.sessionStorage.removeItem(key);
    } else {
      window.sessionStorage.setItem(key, value);
    }
  } catch {
    // Private browsing or blocked storage — the flow degrades to an explicit
    // reconnect rather than failing outright.
  }
};

const firstStringClaim = (claims: object, names: string[]): string | null => {
  for (const name of names) {
    const value = Reflect.get(claims, name);
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return null;
};

const usernameOf = (user: User | null): string | null =>
  user?.profile ? firstStringClaim(user.profile, ['preferred_username', 'name', 'email']) : null;

const stringField = (entry: object, name: string): string | undefined => {
  const value = Reflect.get(entry, name);
  return typeof value === 'string' && value ? value : undefined;
};

const featureMap = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const features: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(value)) {
    features[name] = enabled === true;
  }
  return features;
};

/**
 * Maps one wire entry onto the client type, field by field rather than by cast.
 * A cast asserts the shape without reading it, which is how `gatewayVersion`
 * came to be read as `apiVersion` and render as a permanent `undefined`; this
 * puts every wire name in one place to check against the router's serializer.
 */
const toGateway = (entry: unknown): OpenShellGateway | null => {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const id = stringField(entry, 'id');
  if (!id) {
    return null;
  }
  return {
    id,
    name: stringField(entry, 'name') ?? id,
    consoleUrl: stringField(entry, 'consoleUrl'),
    issuer: stringField(entry, 'issuer'),
    clientId: stringField(entry, 'clientId'),
    audience: stringField(entry, 'audience'),
    scope: stringField(entry, 'scope'),
    gatewayVersion: stringField(entry, 'gatewayVersion'),
    features: featureMap(Reflect.get(entry, 'features')),
    connectable: Reflect.get(entry, 'connectable') === true,
    error: stringField(entry, 'error'),
    warning: stringField(entry, 'warning'),
  };
};

/**
 * Fetches the registry of installs from the dashboard's OpenShell router.
 *
 * Never rejects: the caller has to tell three outcomes apart to render them
 * differently — gateways, a cluster where OpenShell was never configured (404,
 * because the router does not register the subtree at all), and a request that
 * genuinely failed — and a thrown error collapses the first two into the third.
 */
export const fetchGateways = async (): Promise<GatewayRegistrySnapshot> => {
  let res: Response;
  try {
    res = await fetch('/openshell/gateways', { credentials: 'same-origin' });
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'Network error' };
  }

  if (res.status === 404) {
    return { status: 'not-configured' };
  }
  if (!res.ok) {
    return { status: 'error', message: `Could not load OpenShell gateways (${res.status})` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: 'error', message: 'The OpenShell router returned a malformed response' };
  }

  const raw = body && typeof body === 'object' ? Reflect.get(body, 'gateways') : null;
  if (!Array.isArray(raw)) {
    return { status: 'ok', gateways: [] };
  }
  const gatewayList: OpenShellGateway[] = [];
  for (const entry of raw) {
    const gateway = toGateway(entry);
    if (gateway) {
      gatewayList.push(gateway);
    }
  }
  return { status: 'ok', gateways: gatewayList };
};

/**
 * Registers a gateway's discovery metadata so a manager can be built for it.
 *
 * Called on every registry poll, not just the first, so it has to be able to
 * move a gateway *out* of the broken state as well as into it: discovery is
 * re-run on the cluster every couple of minutes and a gateway that was
 * unreachable when the dashboard loaded may be fine on the next sweep.
 */
export const registerGateway = (gateway: OpenShellGateway): void => {
  const previous = gateways.get(gateway.id);
  gateways.set(gateway.id, gateway);
  // Discovery that changed identity invalidates any manager built on the old values.
  if (
    previous &&
    (previous.issuer !== gateway.issuer ||
      previous.clientId !== gateway.clientId ||
      previous.audience !== gateway.audience)
  ) {
    managers.get(gateway.id)?.stopSilentRenew();
    managers.delete(gateway.id);
  }

  if (!gateway.connectable) {
    // A live session is NOT torn down by this. `connectable` is a statement
    // about the cluster's config plane — the BFF could not read a gateway's
    // issuer, or could not reach it on this sweep — and it says nothing about
    // whether the token already in this browser is still valid. Discovery is
    // polled, so one bad sweep would otherwise sign the user out mid-task and
    // force a round trip through the IdP they did not need.
    //
    // Keep the session and surface the problem instead; a request that really
    // is refused comes back 401 and moves the state through the normal path.
    if (getConnectionState(gateway.id).status === 'connected') {
      setState(gateway.id, { error: gateway.error ?? null });
      return;
    }
    setState(gateway.id, {
      status: 'unconfigured',
      username: null,
      error: gateway.error ?? null,
    });
    return;
  }

  // Connectable again, but still marked broken from an earlier sweep. Reset to
  // idle so the connect gate re-derives real state; leaving it 'unconfigured'
  // would strand a recovered gateway as permanently unusable in the UI.
  // A gateway that is connectable but advertises no OIDC details is left alone:
  // managerFor() owns that case and re-setting it here would flap every poll.
  if (
    getConnectionState(gateway.id).status === 'unconfigured' &&
    gateway.issuer &&
    gateway.clientId
  ) {
    setState(gateway.id, { status: 'idle', username: null, error: null });
  }
};

/**
 * Drops every client-side trace of a gateway that is no longer discovered.
 *
 * The silent-renew timer is the part that matters: oidc-client-ts keeps a timer
 * per manager, and a gateway removed from the cluster would otherwise go on
 * opening renew iframes against an IdP nobody is watching. The user's session
 * with that gateway is not revoked — if the gateway comes back, signing in
 * again is a silent renew, not a fresh redirect.
 *
 * Subscribers are notified rather than dropped: a component may still be
 * mounted on the vanished gateway and needs to see it reset.
 */
export const forgetGateway = (gatewayId: string): void => {
  managers.get(gatewayId)?.stopSilentRenew();
  managers.delete(gatewayId);
  gateways.delete(gatewayId);
  initInFlight.delete(gatewayId);
  states.delete(gatewayId);
  listeners.get(gatewayId)?.forEach((listener) => listener(IDLE));
};

const managerFor = (gatewayId: string): UserManager | null => {
  const existing = managers.get(gatewayId);
  if (existing) {
    return existing;
  }

  const gateway = gateways.get(gatewayId);
  if (!gateway?.issuer || !gateway.clientId) {
    setState(gatewayId, {
      status: 'unconfigured',
      error: gateway?.error ?? 'Gateway did not advertise an OIDC issuer and client id',
    });
    return null;
  }

  const { origin } = window.location;
  const manager = new UserManager({
    // oidc-client-ts mirrors the OIDC spec's snake_case parameter names.
    /* eslint-disable camelcase */
    authority: gateway.issuer,
    client_id: gateway.clientId,
    redirect_uri: `${origin}${OIDC_CALLBACK_PATH}`,
    silent_redirect_uri: `${origin}${OIDC_SILENT_CALLBACK_PATH}`,
    post_logout_redirect_uri: origin,
    response_type: 'code',
    /* eslint-enable camelcase */
    scope: gateway.scope || 'openid profile',
    // Request the gateway's audience so the minted token is accepted by its JWKS
    // validation. A token minted for the wrong audience is rejected five hops away
    // with no diagnostic, so this must match what discovery reported.
    extraQueryParams: gateway.audience ? { audience: gateway.audience } : undefined,
    // Each gateway gets its own keyspace so sessions never collide.
    userStore: new WebStorageStateStore({
      store: window.sessionStorage,
      prefix: `oidc.openshell.${gatewayId}.`,
    }),
    // The in-flight sign-in state needs its own keyspace for the same reason the
    // session does. Left to the default every gateway shares one `oidc.` prefix
    // in localStorage, so one gateway's manager can read another's pending
    // authorization state and the only thing refusing the swap is the library's
    // own client_id/authority check deep inside response validation. Splitting
    // the keyspace moves that refusal to the storage boundary, where the rest of
    // this module already draws it. localStorage (the default store) is kept:
    // the state has to outlive a full-page redirect to the IdP and back.
    stateStore: new WebStorageStateStore({
      store: window.localStorage,
      prefix: `oidc.openshell.${gatewayId}.state.`,
    }),
    automaticSilentRenew: true,
    monitorSession: false,
  });

  manager.events.addUserLoaded((user) =>
    setState(gatewayId, { status: 'connected', username: usernameOf(user), error: null }),
  );
  manager.events.addUserUnloaded(() =>
    setState(gatewayId, { status: 'disconnected', username: null }),
  );
  manager.events.addSilentRenewError((e) =>
    setState(gatewayId, { status: 'error', error: e.message }),
  );

  managers.set(gatewayId, manager);
  return manager;
};

/**
 * Per-request token provider for a gateway. Returns a fresh token, refreshing
 * silently when the session is resumable. Returns null when the user must sign in,
 * which surfaces as a connect prompt rather than a failed request.
 */
export const getToken = async (gatewayId: string): Promise<string | null> => {
  const manager = managerFor(gatewayId);
  if (!manager) {
    return null;
  }

  const user = await manager.getUser();
  if (user && !user.expired) {
    return user.access_token;
  }
  if (!user) {
    // No session for this gateway — an explicit sign-in is required.
    return null;
  }

  try {
    const renewed = await manager.signinSilent();
    if (renewed) {
      setState(gatewayId, {
        status: 'connected',
        username: usernameOf(renewed),
        error: null,
      });
      return renewed.access_token;
    }
  } catch {
    setState(gatewayId, { status: 'disconnected', username: null });
  }
  return null;
};

const runInitConnection = async (gatewayId: string): Promise<void> => {
  const manager = managerFor(gatewayId);
  if (!manager) {
    return; // 'unconfigured' already set
  }

  const user = await manager.getUser();
  if (user && !user.expired) {
    setState(gatewayId, { status: 'connected', username: usernameOf(user), error: null });
    return;
  }
  if (user) {
    await getToken(gatewayId);
    return;
  }
  setState(gatewayId, { status: 'disconnected', username: null });
};

/**
 * Establishes connection state for a gateway without forcing a login: resumes an
 * existing session or attempts a silent renew, otherwise leaves it disconnected so
 * the connect gate is shown.
 *
 * Several surfaces seed the same gateway — the mounted gateway's provider, and a
 * list showing status for every gateway at once — so concurrent calls share one
 * in-flight attempt rather than racing each other through the token endpoint.
 */
export const initConnection = (gatewayId: string): Promise<void> => {
  const existing = initInFlight.get(gatewayId);
  if (existing) {
    return existing;
  }
  const attempt = runInitConnection(gatewayId).finally(() => {
    initInFlight.delete(gatewayId);
  });
  initInFlight.set(gatewayId, attempt);
  return attempt;
};

/**
 * Interactive connect. Tries silent first — when the gateway's IdP is the one the
 * user already has an SSO session with, this completes with no visible login at
 * all. Falls back to a redirect when it genuinely is a different identity domain.
 */
export const connect = async (gatewayId: string, returnTo?: string): Promise<void> => {
  const manager = managerFor(gatewayId);
  if (!manager) {
    return;
  }

  setState(gatewayId, { status: 'connecting', error: null });
  try {
    const user = await manager.signinSilent();
    if (user) {
      setState(gatewayId, { status: 'connected', username: usernameOf(user), error: null });
      return;
    }
  } catch {
    // Not an error — it just means this gateway needs an explicit sign-in.
  }

  writeSession(PENDING_GATEWAY_KEY, gatewayId);
  writeSession(RETURN_TO_KEY, returnTo ?? window.location.pathname);
  // The gateway id also rides the OIDC state so the callback can verify it
  // against the pending marker rather than trusting storage alone.
  await manager.signinRedirect({ state: { gatewayId } });
};

export const disconnect = async (gatewayId: string): Promise<void> => {
  const manager = managerFor(gatewayId);
  if (!manager) {
    return;
  }
  await manager.removeUser();
  setState(gatewayId, { status: 'disconnected', username: null });
};

export const isCallbackPath = (pathname: string): boolean =>
  pathname === OIDC_CALLBACK_PATH || pathname === OIDC_SILENT_CALLBACK_PATH;

/**
 * A callback always runs in a document that has just been created — a full page
 * load after the IdP redirect, or a brand new silent-renew iframe — so no
 * manager exists yet and discovery is what rebuilds one.
 */
const loadAndRegister = async (
  loadGateways: () => Promise<GatewayRegistrySnapshot>,
): Promise<void> => {
  const discovered = await loadGateways();
  if (discovered.status === 'error') {
    // Without discovery there is no issuer to finish against; say so rather
    // than bouncing the user back with a half-completed sign-in.
    throw new Error(discovered.message);
  }
  if (discovered.status === 'ok') {
    discovered.gateways.forEach(registerGateway);
  }
};

/**
 * A manager able to hand a silent-renew response back to the tab that started
 * it — signinSilentCallback's whole job in the iframe is to post the response
 * URL to the parent window.
 *
 * Which manager does the forwarding does not affect whose session is renewed:
 * the parent window still holds the manager that started the renew, and that
 * manager is the only thing that looks the OIDC state up, checks it was issued
 * for its own issuer and client id, and stores the resulting token. So this
 * prefers the gateway the pending marker names but does not require one.
 */
const silentRenewForwarder = (preferred: string | null): UserManager | null => {
  const canSignIn = (id: string): boolean => {
    const gateway = gateways.get(id);
    return !!gateway?.issuer && !!gateway.clientId;
  };
  if (preferred && canSignIn(preferred)) {
    return managerFor(preferred);
  }
  for (const id of gateways.keys()) {
    if (canSignIn(id)) {
      return managerFor(id);
    }
  }
  return null;
};

const clearPendingSignin = (): void => {
  writeSession(PENDING_GATEWAY_KEY, null);
  writeSession(RETURN_TO_KEY, null);
};

/**
 * Completes a redirect or silent-renew callback. For the interactive redirect
 * the gateway being completed is read from the pending marker and verified
 * against the OIDC state; a mismatch (two tabs racing, a stale marker) is
 * reported rather than silently completing the wrong gateway's session.
 */
export const handleCallback = async (
  loadGateways: () => Promise<GatewayRegistrySnapshot>,
): Promise<string> => {
  const pending = readSession(PENDING_GATEWAY_KEY);

  if (window.location.pathname === OIDC_SILENT_CALLBACK_PATH) {
    // A silent renew is not a sign-in and must NOT depend on the pending
    // marker: that marker is cleared the instant an interactive sign-in
    // completes, so it is null for every automatic renew that follows. Gating
    // this path on it meant the iframe never answered, the parent's
    // signinSilent() timed out against its own deadline, and a perfectly good
    // session flipped to 'Sign-in failed' about a minute before every token
    // expiry — for every gateway, on every session.
    await loadAndRegister(loadGateways);
    const forwarder = silentRenewForwarder(pending);
    if (forwarder) {
      await forwarder.signinSilentCallback();
    }
    // Nothing navigates an iframe; the caller discards this.
    return AGENTS_ROOT;
  }

  if (!pending) {
    // Nothing in this tab started a sign-in, so there is nothing to finish.
    return AGENTS_ROOT;
  }

  await loadAndRegister(loadGateways);

  // Only ever written by connect(), and always with an internal path — but it is
  // read back out of storage and handed straight to a location assignment, so it
  // is confined to this area rather than trusted. Anything else (an absolute or
  // protocol-relative URL, a path elsewhere in the dashboard) falls back into the
  // gateway that was being signed into: whatever went wrong, its own page is
  // where the reason is shown.
  const stored = readSession(RETURN_TO_KEY);
  const returnTo =
    stored === AGENTS_ROOT || stored?.startsWith(`${AGENTS_ROOT}/`)
      ? stored
      : gatewayRoute(pending);

  const manager = managerFor(pending);
  if (!manager) {
    // managerFor has already recorded why. The marker has to go with it, or the
    // next callback in this tab would try to finish against the same dead id.
    clearPendingSignin();
    return gatewayRoute(pending);
  }

  const user = await manager.signinCallback();
  const stateGateway =
    user?.state && typeof user.state === 'object'
      ? Reflect.get(user.state, 'gatewayId')
      : undefined;
  if (typeof stateGateway === 'string' && stateGateway !== pending) {
    // Two tabs raced, or the marker outlived the flow that wrote it. Refuse the
    // completion outright and clear the marker so the stale id cannot be picked
    // up again by the next callback.
    clearPendingSignin();
    setState(pending, {
      status: 'error',
      error: 'Sign-in completed for a different gateway; please try again.',
    });
    return AGENTS_ROOT;
  }

  clearPendingSignin();
  if (user) {
    setState(pending, { status: 'connected', username: usernameOf(user), error: null });
  }
  return returnTo;
};
