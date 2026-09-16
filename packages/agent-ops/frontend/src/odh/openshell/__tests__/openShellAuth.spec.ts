import {
  fetchGateways,
  forgetGateway,
  getConnectionState,
  handleCallback,
  initConnection,
  OIDC_CALLBACK_PATH,
  OIDC_SILENT_CALLBACK_PATH,
  registerGateway,
  subscribeConnection,
  type GatewayRegistrySnapshot,
  type OpenShellGateway,
} from '~/odh/openshell/openShellAuth';

const mockStopSilentRenew = jest.fn();
const mockGetUser = jest.fn();
const mockSigninSilentCallback = jest.fn();
const mockSigninCallback = jest.fn();

// The real oidc-client-ts would open network calls and timers; only the surface
// openShellAuth touches matters here.
jest.mock(
  'oidc-client-ts',
  () => ({
    UserManager: jest.fn().mockImplementation(() => ({
      events: {
        addUserLoaded: jest.fn(),
        addUserUnloaded: jest.fn(),
        addSilentRenewError: jest.fn(),
      },
      getUser: mockGetUser,
      stopSilentRenew: mockStopSilentRenew,
      signinSilent: jest.fn(),
      signinSilentCallback: mockSigninSilentCallback,
      signinCallback: mockSigninCallback,
      removeUser: jest.fn(),
    })),
    WebStorageStateStore: jest.fn(),
  }),
  { virtual: true },
);

/**
 * jsdom's window.location cannot be redefined, so the document is navigated
 * instead. The callback path is what handleCallback branches on.
 */
const atPath = (pathname: string): void => {
  window.history.replaceState({}, '', pathname);
};

/**
 * What signinCallback resolves to. OIDC profile claims are snake_case by
 * specification, so the name is spelled the way the IdP actually sends it.
 */
const signedInAs = (username: string, gatewayId: string): object => ({
  // eslint-disable-next-line camelcase
  profile: { preferred_username: username },
  state: { gatewayId },
});

const mockFetch = jest.fn();

const respondWith = (status: number, body?: unknown): void => {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
};

const gateway = (overrides: Partial<OpenShellGateway> & { id: string }): OpenShellGateway => ({
  name: overrides.id,
  features: {},
  connectable: true,
  ...overrides,
});

describe('fetchGateways', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.fetch = mockFetch;
  });

  it('should report a cluster without OpenShell discovery as not-configured rather than an error', async () => {
    respondWith(404);

    await expect(fetchGateways()).resolves.toStrictEqual({ status: 'not-configured' });
  });

  it('should report any other non-2xx as an error', async () => {
    respondWith(503);

    await expect(fetchGateways()).resolves.toStrictEqual({
      status: 'error',
      message: 'Could not load OpenShell gateways (503)',
    });
  });

  it('should report a rejected request as an error rather than throwing', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));

    await expect(fetchGateways()).resolves.toStrictEqual({
      status: 'error',
      message: 'Failed to fetch',
    });
  });

  it('should keep the gatewayVersion and warning the router sends', async () => {
    respondWith(200, {
      gateways: [
        {
          id: 'prod',
          name: 'Production',
          features: { terminal: false, snapshots: true },
          connectable: true,
          gatewayVersion: '1.4.2',
          warning: 'gateway audience differs from the browser client id',
        },
      ],
    });

    const result = await fetchGateways();

    expect(result).toStrictEqual({
      status: 'ok',
      gateways: [
        {
          id: 'prod',
          name: 'Production',
          consoleUrl: undefined,
          issuer: undefined,
          clientId: undefined,
          audience: undefined,
          scope: undefined,
          gatewayVersion: '1.4.2',
          features: { terminal: false, snapshots: true },
          connectable: true,
          error: undefined,
          warning: 'gateway audience differs from the browser client id',
        },
      ],
    });
  });

  it('should drop entries the router could not identify', async () => {
    respondWith(200, { gateways: [{ name: 'nameless' }, null, { id: 'ok' }] });

    const result = await fetchGateways();

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' ? result.gateways.map((g) => g.id) : []).toStrictEqual(['ok']);
  });

  it('should tolerate a body that is not a gateway list', async () => {
    respondWith(200, { gateways: 'nope' });

    await expect(fetchGateways()).resolves.toStrictEqual({ status: 'ok', gateways: [] });
  });
});

describe('registerGateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should mark a gateway that is not connectable as unconfigured', () => {
    registerGateway(
      gateway({ id: 'broken-1', connectable: false, error: 'gateway is unreachable' }),
    );

    expect(getConnectionState('broken-1')).toStrictEqual({
      status: 'unconfigured',
      username: null,
      error: 'gateway is unreachable',
    });
  });

  it('should clear a stale unconfigured state when the gateway recovers across a resync', () => {
    registerGateway(
      gateway({ id: 'flaky-1', connectable: false, error: 'gateway is unreachable' }),
    );
    expect(getConnectionState('flaky-1').status).toBe('unconfigured');

    registerGateway(
      gateway({
        id: 'flaky-1',
        connectable: true,
        issuer: 'https://idp.example.com',
        clientId: 'openshell',
      }),
    );

    expect(getConnectionState('flaky-1')).toStrictEqual({
      status: 'idle',
      username: null,
      error: null,
    });
  });

  it('should leave a connectable gateway that advertises no OIDC details unconfigured', () => {
    registerGateway(
      gateway({ id: 'flaky-2', connectable: false, error: 'gateway is unreachable' }),
    );

    registerGateway(gateway({ id: 'flaky-2', connectable: true }));

    expect(getConnectionState('flaky-2').status).toBe('unconfigured');
  });
});

describe('forgetGateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue(null);
  });

  it('should stop the silent renew and reset the connection state', async () => {
    registerGateway(
      gateway({
        id: 'gone-1',
        connectable: true,
        issuer: 'https://idp.example.com',
        clientId: 'openshell',
      }),
    );
    await initConnection('gone-1');
    expect(getConnectionState('gone-1').status).toBe('disconnected');

    forgetGateway('gone-1');

    expect(mockStopSilentRenew).toHaveBeenCalledTimes(1);
    expect(getConnectionState('gone-1')).toStrictEqual({
      status: 'idle',
      username: null,
      error: null,
    });
  });

  it('should notify anyone still subscribed to the gateway', async () => {
    registerGateway(
      gateway({
        id: 'gone-2',
        connectable: true,
        issuer: 'https://idp.example.com',
        clientId: 'openshell',
      }),
    );
    await initConnection('gone-2');

    const listener = jest.fn();
    const unsubscribe = subscribeConnection('gone-2', listener);
    listener.mockClear();

    forgetGateway('gone-2');

    expect(listener).toHaveBeenCalledWith({ status: 'idle', username: null, error: null });
    unsubscribe();
  });
});

describe('handleCallback', () => {
  const configured = (id: string): OpenShellGateway =>
    gateway({ id, issuer: 'https://idp.example.com', clientId: 'openshell' });

  const discovering = (...ids: string[]): (() => Promise<GatewayRegistrySnapshot>) =>
    jest.fn().mockResolvedValue({ status: 'ok', gateways: ids.map(configured) });

  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    mockSigninSilentCallback.mockResolvedValue(undefined);
    mockSigninCallback.mockResolvedValue(null);
  });

  describe('silent renew', () => {
    // The pending marker is written by connect() and cleared the moment an
    // interactive sign-in completes, so it is ALWAYS absent by the time an
    // automatic renew runs. Requiring it left the iframe silent, the parent's
    // signinSilent() to time out, and a live session to flip to 'error'.
    it('should complete a silent renew with no pending marker in storage', async () => {
      atPath(OIDC_SILENT_CALLBACK_PATH);

      await handleCallback(discovering('renew-1'));

      expect(mockSigninSilentCallback).toHaveBeenCalledTimes(1);
    });

    it('should not consume the interactive pending marker', async () => {
      atPath(OIDC_SILENT_CALLBACK_PATH);
      window.sessionStorage.setItem('openshell.pending-gateway', 'renew-2');

      await handleCallback(discovering('renew-2'));

      expect(mockSigninSilentCallback).toHaveBeenCalledTimes(1);
      expect(window.sessionStorage.getItem('openshell.pending-gateway')).toBe('renew-2');
    });

    it('should stay silent when no discovered gateway can sign anyone in', async () => {
      atPath(OIDC_SILENT_CALLBACK_PATH);
      // The gateway registry is module-level, so this needs a module nobody has
      // registered a usable gateway into yet.
      jest.resetModules();
      const fresh = await import('~/odh/openshell/openShellAuth');
      const loadGateways = jest
        .fn()
        .mockResolvedValue({ status: 'ok', gateways: [gateway({ id: 'no-oidc' })] });

      await fresh.handleCallback(loadGateways);

      expect(mockSigninSilentCallback).not.toHaveBeenCalled();
    });
  });

  describe('interactive redirect', () => {
    it('should complete the pending gateway and return where the sign-in started', async () => {
      atPath(OIDC_CALLBACK_PATH);
      window.sessionStorage.setItem('openshell.pending-gateway', 'redirect-1');
      window.sessionStorage.setItem(
        'openshell.return-to',
        '/ai-hub/agents/deployments/gateways/redirect-1',
      );
      mockSigninCallback.mockResolvedValue(signedInAs('alice', 'redirect-1'));

      const returnTo = await handleCallback(discovering('redirect-1'));

      expect(returnTo).toBe('/ai-hub/agents/deployments/gateways/redirect-1');
      expect(getConnectionState('redirect-1')).toStrictEqual({
        status: 'connected',
        username: 'alice',
        error: null,
      });
      expect(window.sessionStorage.getItem('openshell.pending-gateway')).toBeNull();
    });

    it('should do nothing when no sign-in was started in this tab', async () => {
      atPath(OIDC_CALLBACK_PATH);
      const loadGateways = discovering('redirect-2');

      await handleCallback(loadGateways);

      expect(loadGateways).not.toHaveBeenCalled();
      expect(mockSigninCallback).not.toHaveBeenCalled();
    });

    // A marker that outlived its flow must not be left behind to be picked up by
    // the next callback in this tab.
    it('should refuse a response minted for a different gateway and clear the marker', async () => {
      atPath(OIDC_CALLBACK_PATH);
      window.sessionStorage.setItem('openshell.pending-gateway', 'redirect-3');
      mockSigninCallback.mockResolvedValue(signedInAs('mallory', 'somewhere-else'));

      await handleCallback(discovering('redirect-3'));

      expect(getConnectionState('redirect-3')).toStrictEqual({
        status: 'error',
        username: null,
        error: 'Sign-in completed for a different gateway; please try again.',
      });
      expect(window.sessionStorage.getItem('openshell.pending-gateway')).toBeNull();
    });

    it('should fall back into the gateway page when nothing recorded a return path', async () => {
      atPath(OIDC_CALLBACK_PATH);
      window.sessionStorage.setItem('openshell.pending-gateway', 'redirect 4');
      mockSigninCallback.mockResolvedValue({ profile: {}, state: { gatewayId: 'redirect 4' } });

      await expect(handleCallback(discovering('redirect 4'))).resolves.toBe(
        '/ai-hub/agents/deployments/gateways/redirect%204',
      );
    });

    it('should refuse a return path that leaves the agents area', async () => {
      atPath(OIDC_CALLBACK_PATH);
      window.sessionStorage.setItem('openshell.pending-gateway', 'redirect-6');
      window.sessionStorage.setItem('openshell.return-to', '//evil.example.com/steal');
      mockSigninCallback.mockResolvedValue(signedInAs('alice', 'redirect-6'));

      await expect(handleCallback(discovering('redirect-6'))).resolves.toBe(
        '/ai-hub/agents/deployments/gateways/redirect-6',
      );
    });

    it('should surface a failed discovery rather than half-completing a sign-in', async () => {
      atPath(OIDC_CALLBACK_PATH);
      window.sessionStorage.setItem('openshell.pending-gateway', 'redirect-5');
      const loadGateways = jest
        .fn()
        .mockResolvedValue({ status: 'error', message: 'Could not load OpenShell gateways (503)' });

      await expect(handleCallback(loadGateways)).rejects.toThrow(
        'Could not load OpenShell gateways (503)',
      );
      expect(mockSigninCallback).not.toHaveBeenCalled();
    });
  });

  it('does not sign a connected user out when a discovery sweep reports the gateway unconnectable', async () => {
    // `connectable` describes the cluster's config plane -- the BFF could not read
    // a gateway's issuer, or could not reach it on this sweep. It says nothing
    // about whether the token already in this browser is still valid. Discovery
    // is polled, so clobbering the session here signs the user out mid-task on
    // one bad sweep and forces an IdP round trip they did not need.
    const gw = {
      id: 'gw',
      name: 'gw',
      connectable: true,
      issuer: 'https://idp',
      clientId: 'c',
    } as unknown as OpenShellGateway;

    // oidc-client-ts' User is snake_case on the wire; mirror it rather than
    // renaming the fixture into something the library would never hand back.
    /* eslint-disable camelcase */
    mockGetUser.mockResolvedValue({
      access_token: 'tok',
      expired: false,
      profile: { preferred_username: 'alice' },
    });
    /* eslint-enable camelcase */

    registerGateway(gw);
    await initConnection('gw');
    expect(getConnectionState('gw').status).toBe('connected');

    registerGateway({ ...gw, connectable: false, error: 'gateway unreachable' });

    const after = getConnectionState('gw');
    expect(after.status).toBe('connected');
    expect(after.error).toBe('gateway unreachable');
  });
});
