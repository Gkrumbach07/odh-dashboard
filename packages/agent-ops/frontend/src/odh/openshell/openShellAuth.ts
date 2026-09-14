import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';

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
  apiVersion?: string;
  features: Record<string, boolean>;
  connectable: boolean;
  authDisabled?: boolean;
  error?: string;
};

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

const AGENTS_ROOT = '/ai-hub/agents';
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

const IDLE: OpenShellConnectionState = { status: 'idle', username: null, error: null };

export const getConnectionState = (gatewayId: string): OpenShellConnectionState =>
  states.get(gatewayId) ?? IDLE;

const setState = (gatewayId: string, next: Partial<OpenShellConnectionState>): void => {
  const merged = { ...getConnectionState(gatewayId), ...next };
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

/** Fetches the registry of installs from the dashboard's OpenShell router. */
export const fetchGateways = async (): Promise<OpenShellGateway[]> => {
  const res = await fetch('/openshell/gateways', { credentials: 'same-origin' });
  if (!res.ok) {
    throw new Error(`Could not load OpenShell gateways (${res.status})`);
  }
  const body: unknown = await res.json();
  const raw = body && typeof body === 'object' ? Reflect.get(body, 'gateways') : null;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is OpenShellGateway => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    return typeof Reflect.get(entry, 'id') === 'string';
  });
};

/** Registers a gateway's discovery metadata so a manager can be built for it. */
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
    managers.delete(gateway.id);
  }
  if (!gateway.connectable && !gateway.authDisabled) {
    setState(gateway.id, { status: 'unconfigured', error: gateway.error ?? null });
  }
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
  if (gateways.get(gatewayId)?.authDisabled) {
    return null; // Gateway runs without auth; the relay expects no bearer.
  }

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

/**
 * Establishes connection state for a gateway without forcing a login: resumes an
 * existing session or attempts a silent renew, otherwise leaves it disconnected so
 * the connect gate is shown.
 */
export const initConnection = async (gatewayId: string): Promise<void> => {
  const gateway = gateways.get(gatewayId);
  if (gateway?.authDisabled) {
    setState(gatewayId, { status: 'connected', username: null, error: null });
    return;
  }

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
 * Completes a redirect or silent-renew callback. The gateway being completed is
 * read from the pending marker and verified against the OIDC state; a mismatch
 * (two tabs racing, a stale marker) is reported rather than silently completing
 * the wrong gateway's session.
 */
export const handleCallback = async (
  loadGateways: () => Promise<OpenShellGateway[]>,
): Promise<string> => {
  const pending = readSession(PENDING_GATEWAY_KEY);
  const returnTo = readSession(RETURN_TO_KEY) ?? AGENTS_ROOT;

  if (!pending) {
    return AGENTS_ROOT;
  }

  // Discovery is needed to rebuild the manager after a full page redirect.
  const discovered = await loadGateways();
  discovered.forEach(registerGateway);

  const manager = managerFor(pending);
  if (!manager) {
    return AGENTS_ROOT;
  }

  if (window.location.pathname === OIDC_SILENT_CALLBACK_PATH) {
    await manager.signinSilentCallback();
    return returnTo;
  }

  const user = await manager.signinCallback();
  const stateGateway =
    user?.state && typeof user.state === 'object'
      ? Reflect.get(user.state, 'gatewayId')
      : undefined;
  if (typeof stateGateway === 'string' && stateGateway !== pending) {
    setState(pending, {
      status: 'error',
      error: 'Sign-in completed for a different gateway; please try again.',
    });
    return AGENTS_ROOT;
  }

  writeSession(PENDING_GATEWAY_KEY, null);
  writeSession(RETURN_TO_KEY, null);
  if (user) {
    setState(pending, { status: 'connected', username: usernameOf(user), error: null });
  }
  return returnTo;
};
