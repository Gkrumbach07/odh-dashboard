import * as React from 'react';
import {
  Button,
  Bullseye,
  Divider,
  Dropdown,
  DropdownItem,
  DropdownList,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Flex,
  FlexItem,
  Label,
  MenuToggle,
  type MenuToggleElement,
  Select,
  SelectList,
  SelectOption,
  Skeleton,
  Spinner,
} from '@patternfly/react-core';
import {
  CheckCircleIcon,
  ConnectedIcon,
  DisconnectedIcon,
  ExclamationCircleIcon,
  ServerIcon,
} from '@patternfly/react-icons';
import { setApiBasePath, setAuthTokenGetter, setAuthTokenHeader } from 'openshell-dashboard/api';
import { openShellGatewayApiBasePath } from '~/app/utilities/routes';
import {
  connect,
  disconnect,
  fetchGateways,
  forgetGateway,
  getConnectionState,
  getToken,
  initConnection,
  registerGateway,
  subscribeConnection,
  OPENSHELL_AUTH_HEADER,
  OPENSHELL_SESSION_EXPIRED_EVENT,
  type OpenShellConnectionState,
  type OpenShellGateway,
} from './openShellAuth';
import { releaseQueryClient } from './gatewayQueryClients';

// ─── Registry ────────────────────────────────────────────────────────────────
// Which OpenShell installs exist, and what each says about its identity domain.
// Shared across the whole OpenShell area; the switcher and the gateway list read it.

/**
 * How often discovery is re-read. Gateways are found on the cluster and the set
 * changes at runtime — the router re-runs discovery roughly every two minutes —
 * so a registry read once at mount is stale for the rest of the session. This is
 * the only thing that makes a gateway appearing, vanishing or recovering visible
 * without a page reload.
 */
export const GATEWAY_REGISTRY_POLL_MS = 60_000;

export type GatewayRegistryValue = {
  /**
   * The last answer that actually arrived. Deliberately retained when a refresh
   * fails, so a dropped poll never blanks a page that is already showing
   * gateways.
   */
  gateways: OpenShellGateway[];
  /** First read, nothing to show yet. False for every refresh after that. */
  isLoading: boolean;
  /** A refresh is in flight over data already on screen. */
  isRefreshing: boolean;
  /**
   * Nothing serves the gateway registry endpoint on this deployment: it
   * answered 404. Not an error — a calm "nothing here yet" that reads
   * differently from "we could not find out". (A BFF that IS there but has no
   * gateway discovery configured answers 200 with an empty list, which arrives
   * as zero gateways rather than as this flag.)
   */
  isNotConfigured: boolean;
  /** Discovery failed and there is nothing behind it to show. */
  error: string | null;
  /** The last refresh failed, but `gateways` is still the last good answer. */
  refreshError: string | null;
  /** Epoch ms of the last answer, for a "last updated" line. */
  lastUpdated: number | null;
  reload: () => void;
};

const NO_GATEWAYS: OpenShellGateway[] = [];

const GatewayRegistryContext = React.createContext<GatewayRegistryValue>({
  gateways: NO_GATEWAYS,
  isLoading: true,
  isRefreshing: false,
  isNotConfigured: false,
  error: null,
  refreshError: null,
  lastUpdated: null,
  reload: () => undefined,
});

export const useGatewayRegistry = (): GatewayRegistryValue =>
  React.useContext(GatewayRegistryContext);

/**
 * Gateways with a live ActiveGatewayProvider. A gateway that drops out of
 * discovery while the user is on its page must not be torn down underneath
 * them, so the poll leaves anything mounted alone and the provider cleans up on
 * its way out instead.
 */
const mountedGateways = new Set<string>();

/**
 * Releases everything a gateway owns on this client: its OIDC manager and
 * silent-renew timer, its connection state, and its resource cache. Ids are
 * reused (they come from an operator-supplied annotation, or namespace/name),
 * so anything left behind would be handed to whatever install next appears
 * under the same id.
 */
const releaseGateway = (gatewayId: string): void => {
  forgetGateway(gatewayId);
  releaseQueryClient(gatewayId);
};

const sameFeatures = (a: Record<string, boolean>, b: Record<string, boolean>): boolean => {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => a[name] === b[name]);
};

const sameGateway = (a: OpenShellGateway, b: OpenShellGateway): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.consoleUrl === b.consoleUrl &&
  a.issuer === b.issuer &&
  a.clientId === b.clientId &&
  a.audience === b.audience &&
  a.scope === b.scope &&
  a.gatewayVersion === b.gatewayVersion &&
  a.connectable === b.connectable &&
  a.error === b.error &&
  a.warning === b.warning &&
  sameFeatures(a.features, b.features);

/**
 * Whether a poll actually changed anything. Polling that replaced the array
 * every minute regardless would re-run every effect keyed on a gateway and
 * remount per-gateway state on a timer, so an unchanged answer keeps the
 * previous reference.
 */
const sameGateways = (a: OpenShellGateway[], b: OpenShellGateway[]): boolean =>
  a.length === b.length && a.every((gateway, index) => sameGateway(gateway, b[index]));

type RegistryState = {
  gateways: OpenShellGateway[];
  isLoading: boolean;
  isNotConfigured: boolean;
  error: string | null;
  refreshError: string | null;
  lastUpdated: number | null;
};

const INITIAL_REGISTRY: RegistryState = {
  gateways: NO_GATEWAYS,
  isLoading: true,
  isNotConfigured: false,
  error: null,
  refreshError: null,
  lastUpdated: null,
};

export const GatewayRegistryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [registry, setRegistry] = React.useState<RegistryState>(INITIAL_REGISTRY);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const mountedRef = React.useRef(true);
  const inFlightRef = React.useRef(false);
  const knownIdsRef = React.useRef<Set<string>>(new Set());

  const load = React.useCallback(async (): Promise<void> => {
    // A manual reload landing on top of an interval tick would race two answers
    // into the same state. The request already in flight is about to report the
    // same registry, so the second one simply does not start.
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setIsRefreshing(true);

    const result = await fetchGateways().finally(() => {
      inFlightRef.current = false;
    });
    if (!mountedRef.current) {
      return;
    }
    setIsRefreshing(false);

    if (result.status === 'error') {
      setRegistry((previous) =>
        previous.gateways.length > 0
          ? // Last-good retention: the gateways on screen are still the best
            // answer anyone has, so the failure is reported beside them rather
            // than in place of them.
            { ...previous, isLoading: false, refreshError: result.message }
          : {
              ...previous,
              isLoading: false,
              isNotConfigured: false,
              error: result.message,
              refreshError: null,
            },
      );
      return;
    }

    const found = result.status === 'ok' ? result.gateways : NO_GATEWAYS;
    found.forEach(registerGateway);

    // Anything that dropped out of discovery and is not on screen is released:
    // its silent-renew timer would otherwise keep firing at an IdP for an
    // install that no longer exists.
    const foundIds = new Set(found.map((gateway) => gateway.id));
    const stillKnown = new Set(foundIds);
    knownIdsRef.current.forEach((id) => {
      if (foundIds.has(id)) {
        return;
      }
      if (mountedGateways.has(id)) {
        stillKnown.add(id);
      } else {
        releaseGateway(id);
      }
    });
    knownIdsRef.current = stillKnown;

    setRegistry((previous) => ({
      gateways: sameGateways(previous.gateways, found) ? previous.gateways : found,
      isLoading: false,
      isNotConfigured: result.status === 'not-configured',
      error: null,
      refreshError: null,
      lastUpdated: Date.now(),
    }));
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    void load();

    // A hidden tab has nobody to show a fresher answer to; it catches up the
    // moment it is looked at again.
    const refreshIfVisible = () => {
      if (!document.hidden) {
        void load();
      }
    };
    const interval = window.setInterval(refreshIfVisible, GATEWAY_REGISTRY_POLL_MS);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [load]);

  const value = React.useMemo<GatewayRegistryValue>(
    () => ({
      gateways: registry.gateways,
      isLoading: registry.isLoading,
      isRefreshing,
      isNotConfigured: registry.isNotConfigured,
      error: registry.error,
      refreshError: registry.refreshError,
      lastUpdated: registry.lastUpdated,
      reload: () => void load(),
    }),
    [registry, isRefreshing, load],
  );

  return (
    <GatewayRegistryContext.Provider value={value}>{children}</GatewayRegistryContext.Provider>
  );
};

// ─── Per-gateway connection ──────────────────────────────────────────────────

/**
 * Live connection state for ANY discovered gateway, mounted or not.
 *
 * Sessions are already per gateway at the auth layer; this is the read side, so
 * a list can show "Connected as alice" beside one gateway and "Not connected"
 * beside the next without mounting either of them. Read-only — it never starts a
 * sign-in. Pair it with useSeedGatewayConnections to make the states real for
 * gateways nobody has opened yet.
 */
export const useGatewayConnection = (gatewayId: string): OpenShellConnectionState =>
  React.useSyncExternalStore(
    React.useCallback(
      (onStoreChange: () => void) => subscribeConnection(gatewayId, onStoreChange),
      [gatewayId],
    ),
    React.useCallback(() => getConnectionState(gatewayId), [gatewayId]),
  );

/**
 * Resumes any existing session for each connectable gateway, without forcing a
 * login. A list that only subscribed would show every unopened gateway as "not
 * connected" even where the user has a perfectly good session.
 */
export const useSeedGatewayConnections = (gateways: OpenShellGateway[]): void => {
  React.useEffect(() => {
    gateways.forEach((gateway) => {
      // 'idle' is the only status nobody has established yet. Everything else,
      // including the 'unconfigured' that registerGateway clears when a gateway
      // recovers, is already a real answer.
      if (gateway.connectable && getConnectionState(gateway.id).status === 'idle') {
        void initConnection(gateway.id);
      }
    });
  }, [gateways]);
};

// ─── Active gateway ──────────────────────────────────────────────────────────
// Sessions are held for every connected gateway at once, but exactly one gateway
// is mounted at a time. That is what keeps the npm package's module-level client
// config (base path, token getter) valid without teaching it about gateways.

/**
 * Which gateway the openshell-dashboard package's module-level client config is
 * currently pointed at. Tracked here rather than in a per-component ref because
 * the config it guards is itself module-global: only the provider that actually
 * owns the binding may release it.
 */
let boundGatewayId: string | null = null;

/**
 * Points the package's client at one gateway. Base path and token getter move
 * together and are never written apart, so a token minted for one gateway can
 * only ever be sent to that gateway's subtree.
 *
 * The base path is derived (see routes.ts) so that every request this client
 * makes rides the module's single reverse-proxied prefix, the same one every
 * other agent-ops request uses.
 */
const bindGateway = (gatewayId: string): void => {
  if (boundGatewayId === gatewayId) {
    return;
  }
  setApiBasePath(openShellGatewayApiBasePath(gatewayId));
  setAuthTokenHeader(OPENSHELL_AUTH_HEADER);
  setAuthTokenGetter(() => getToken(gatewayId));
  boundGatewayId = gatewayId;
};

/**
 * Releases the binding when leaving a gateway, so no request made outside a
 * gateway-scoped page can still be handed the last gateway's token.
 *
 * The ownership check is what makes this safe to call from a cleanup: React
 * renders the incoming tree (which binds the new gateway) BEFORE it runs the
 * outgoing tree's cleanups, so on a gateway switch this runs with the new
 * gateway already bound and must do nothing.
 */
const unbindGateway = (gatewayId: string): void => {
  if (boundGatewayId !== gatewayId) {
    return;
  }
  setAuthTokenGetter(() => Promise.resolve(null));
  boundGatewayId = null;
};

type ActiveGatewayValue = {
  gateway: OpenShellGateway | null;
  state: OpenShellConnectionState;
  connect: () => void;
  disconnect: () => void;
};

const ActiveGatewayContext = React.createContext<ActiveGatewayValue>({
  gateway: null,
  state: { status: 'idle', username: null, error: null },
  connect: () => undefined,
  disconnect: () => undefined,
});

export const useOpenShellConnection = (): ActiveGatewayValue =>
  React.useContext(ActiveGatewayContext);

type ActiveGatewayProviderProps = {
  gatewayId: string;
  children: React.ReactNode;
};

export const ActiveGatewayProvider: React.FC<ActiveGatewayProviderProps> = ({
  gatewayId,
  children,
}) => {
  const { gateways } = useGatewayRegistry();
  const gateway = React.useMemo(
    () => gateways.find((g) => g.id === gatewayId) ?? null,
    [gateways, gatewayId],
  );

  // Bind the package's client config synchronously during render, not in an
  // effect: children mount (and can fire queries) before a parent effect runs, so
  // an effect here would let the first request go out against the previous
  // gateway's base path. The calls are idempotent module-level writes.
  bindGateway(gatewayId);

  // ...and release it on the way out, so nothing rendered after this gateway's
  // page (the gateway list, another area of the dashboard) can still be handed
  // this gateway's token by a stale getter.
  //
  // The setup re-binds rather than trusting the render above: StrictMode mounts,
  // tears down and re-mounts effects without re-rendering, so a cleanup-only
  // effect would leave the binding released for the life of the page.
  React.useEffect(() => {
    bindGateway(gatewayId);
    return () => unbindGateway(gatewayId);
  }, [gatewayId]);

  const [state, setState] = React.useState<OpenShellConnectionState>(() =>
    getConnectionState(gatewayId),
  );

  // Identity, not the whole gateway object: discovery is polled, and re-running
  // the sign-in machinery every time an unrelated field (a warning, a console
  // URL) changes would drop and rebuild the session for no reason.
  const issuer = gateway?.issuer;
  const clientId = gateway?.clientId;

  React.useEffect(() => {
    const unsubscribe = subscribeConnection(gatewayId, setState);
    // Establish state without forcing a login: resume a session or silently renew.
    void initConnection(gatewayId);

    // A second-service session expiry must not tear down the RHOAI context, so it
    // is reflected inline for this gateway only.
    const onExpired = () => void getToken(gatewayId);
    window.addEventListener(OPENSHELL_SESSION_EXPIRED_EVENT, onExpired);
    return () => {
      unsubscribe();
      window.removeEventListener(OPENSHELL_SESSION_EXPIRED_EVENT, onExpired);
    };
  }, [gatewayId, issuer, clientId]);

  // 'idle' means nobody has established this gateway's state yet. That is true
  // at mount, and true AGAIN whenever registerGateway clears a stale
  // 'unconfigured' because a gateway recovered across a discovery sweep. The
  // effect above is keyed on identity, so an install that blipped out and back
  // with the same issuer and client id would not re-run it — leaving the state
  // at 'idle', which OpenShellConnectGate renders as a spinner that never
  // resolves. initConnection de-duplicates, so re-asserting it here is cheap.
  React.useEffect(() => {
    if (state.status === 'idle') {
      void initConnection(gatewayId);
    }
  }, [state.status, gatewayId]);

  // Claim the gateway for as long as this provider is mounted so a poll cannot
  // release it out from under the page, and release it on the way out — by then
  // it may have vanished from the cluster and nothing else would stop its
  // silent renew.
  const discoveredRef = React.useRef(true);
  React.useEffect(() => {
    discoveredRef.current = gateway !== null;
  }, [gateway]);

  React.useEffect(() => {
    mountedGateways.add(gatewayId);
    return () => {
      mountedGateways.delete(gatewayId);
      if (!discoveredRef.current) {
        releaseGateway(gatewayId);
      }
    };
  }, [gatewayId]);

  const value = React.useMemo<ActiveGatewayValue>(
    () => ({
      gateway,
      state,
      connect: () => void connect(gatewayId),
      disconnect: () => void disconnect(gatewayId),
    }),
    [gateway, state, gatewayId],
  );

  return <ActiveGatewayContext.Provider value={value}>{children}</ActiveGatewayContext.Provider>;
};

// ─── Switcher ────────────────────────────────────────────────────────────────

/** Sentinel for the "leave this gateway, show me the list" item. */
export const ALL_GATEWAYS_OPTION = '__all__';

type GatewaySwitcherProps = {
  gatewayId: string;
  onSelect: (gatewayId: string) => void;
  /** Escape hatch back to the gateway list. Omit and the item is not rendered. */
  onSelectAll?: () => void;
};

/**
 * What one option says about a gateway. Connectability (cluster configuration)
 * and connection (this user's session) are separate facts and are never blended
 * into a single "status": an unconnectable gateway is a thing an administrator
 * must fix, a disconnected one is a button away.
 */
const describeGateway = (
  gateway: OpenShellGateway,
  state: OpenShellConnectionState,
): { icon: React.ReactNode; description: string } => {
  if (!gateway.connectable) {
    return {
      icon: <ExclamationCircleIcon className="pf-v6-u-danger-color-100" />,
      description: gateway.error ?? 'Not connectable',
    };
  }
  if (state.status === 'connected') {
    return {
      icon: <CheckCircleIcon className="pf-v6-u-success-color-100" />,
      description: state.username ? `Connected as ${state.username}` : 'Connected',
    };
  }
  if (state.status === 'connecting') {
    return { icon: <Spinner size="sm" />, description: 'Connecting…' };
  }
  if (state.status === 'unconfigured') {
    // Connectable but with no usable sign-in: the router reached it, the gateway
    // just did not say how to authenticate to it.
    return {
      icon: <ExclamationCircleIcon className="pf-v6-u-danger-color-100" />,
      description: state.error ?? 'Missing sign-in configuration',
    };
  }
  if (state.status === 'error') {
    return {
      icon: <ExclamationCircleIcon className="pf-v6-u-danger-color-100" />,
      description: state.error ?? 'Sign-in failed',
    };
  }
  return {
    icon: <DisconnectedIcon className="pf-v6-u-disabled-color-100" />,
    description: 'Not connected',
  };
};

/**
 * One option. Its own component because each one subscribes to its own
 * gateway's connection — you should be able to see what switching would cost
 * before you switch.
 */
const GatewaySwitcherOption: React.FC<{ gateway: OpenShellGateway }> = ({ gateway }) => {
  const state = useGatewayConnection(gateway.id);
  const { icon, description } = describeGateway(gateway, state);

  return (
    <SelectOption
      value={gateway.id}
      icon={icon}
      description={description}
      isDisabled={!gateway.connectable}
      data-testid={`openshell-gateway-option-${gateway.id}`}
    >
      {gateway.name || gateway.id}
    </SelectOption>
  );
};

export const GatewaySwitcher: React.FC<GatewaySwitcherProps> = ({
  gatewayId,
  onSelect,
  onSelectAll,
}) => {
  const { gateways, isLoading } = useGatewayRegistry();
  const [isOpen, setIsOpen] = React.useState(false);

  // Never hidden. On a gateway-scoped page this control is also the "you are
  // here" label, so a single-gateway install still has to be able to see which
  // install it is on; only the *choice* is uninteresting at N=1. Showing a
  // disabled toggle while loading also stops the header jumping when it lands.
  if (isLoading) {
    return (
      <MenuToggle isDisabled icon={<ServerIcon />} data-testid="openshell-gateway-switcher">
        <Skeleton width="140px" screenreaderText="Loading agent gateways" />
      </MenuToggle>
    );
  }

  const active = gateways.find((g) => g.id === gatewayId);
  const hasChoice = gateways.length > 1 || !!onSelectAll;

  return (
    <Select
      isOpen={isOpen}
      selected={gatewayId}
      onOpenChange={setIsOpen}
      onSelect={(_event, value) => {
        setIsOpen(false);
        if (typeof value !== 'string') {
          return;
        }
        if (value === ALL_GATEWAYS_OPTION) {
          onSelectAll?.();
        } else if (value !== gatewayId) {
          // The URL owns which gateway is mounted; this only asks to go there.
          onSelect(value);
        }
      }}
      toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
        <MenuToggle
          ref={toggleRef}
          isExpanded={isOpen}
          isDisabled={!hasChoice}
          icon={<ServerIcon />}
          onClick={() => setIsOpen((open) => !open)}
          data-testid="openshell-gateway-switcher"
        >
          {active?.name || gatewayId}
        </MenuToggle>
      )}
    >
      <SelectList>
        {gateways.map((g) => (
          <GatewaySwitcherOption key={g.id} gateway={g} />
        ))}
        {onSelectAll ? (
          <>
            <Divider component="li" />
            <SelectOption
              value={ALL_GATEWAYS_OPTION}
              data-testid="openshell-gateway-option-all"
              description="Every gateway discovered in this cluster"
            >
              All gateways
            </SelectOption>
          </>
        ) : null}
      </SelectList>
    </Select>
  );
};

/** Compact connection status for the active gateway. Never the global masthead. */
export const OpenShellConnectionChip: React.FC = () => {
  const { state, gateway, connect: doConnect, disconnect: doDisconnect } = useOpenShellConnection();
  const [isOpen, setIsOpen] = React.useState(false);

  if (state.status === 'unconfigured') {
    return null;
  }

  if (state.status === 'connecting') {
    return (
      <Label color="blue" icon={<Spinner size="sm" />} data-testid="openshell-connection-chip">
        Connecting to {gateway?.name ?? 'OpenShell'}…
      </Label>
    );
  }

  if (state.status === 'connected') {
    return (
      <Dropdown
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        onSelect={() => setIsOpen(false)}
        data-testid="openshell-connection-chip"
        toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
          <MenuToggle
            ref={toggleRef}
            isExpanded={isOpen}
            onClick={() => setIsOpen((open) => !open)}
            status="success"
          >
            Connected{state.username ? ` as ${state.username}` : ''}
          </MenuToggle>
        )}
      >
        <DropdownList>
          <DropdownItem isDisabled>{gateway?.name ?? 'OpenShell'}</DropdownItem>
          <DropdownItem onClick={doDisconnect} isDanger>
            Disconnect
          </DropdownItem>
        </DropdownList>
      </Dropdown>
    );
  }

  return (
    <Flex
      gap={{ default: 'gapSm' }}
      alignItems={{ default: 'alignItemsCenter' }}
      data-testid="openshell-connection-chip"
    >
      <FlexItem>
        <Label
          color={state.status === 'error' ? 'red' : 'grey'}
          icon={state.status === 'error' ? <ExclamationCircleIcon /> : <DisconnectedIcon />}
        >
          {gateway?.name ?? 'OpenShell'} disconnected
        </Label>
      </FlexItem>
      <FlexItem>
        <Button variant="link" isInline onClick={doConnect}>
          Reconnect
        </Button>
      </FlexItem>
    </Flex>
  );
};

/**
 * Renders children only once connected to the active gateway. Each gateway is a
 * separate sign-in, so the gate names the gateway rather than talking about
 * "OpenShell" generically.
 */
export const OpenShellConnectGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { state, gateway, connect: doConnect } = useOpenShellConnection();

  if (state.status === 'connected') {
    return <>{children}</>;
  }

  if (state.status === 'idle' || state.status === 'connecting') {
    return (
      <Bullseye>
        <Spinner aria-label="Connecting to OpenShell" />
      </Bullseye>
    );
  }

  const name = gateway?.name ?? 'this gateway';
  const unconfigured = state.status === 'unconfigured';
  // A gateway can be unconnectable for reasons that have nothing to do with
  // OIDC — unreachable, TLS, a capability turned off — so say what discovery
  // actually reported and fall back to the OIDC sentence only when it said
  // nothing.
  const reason = state.error ?? gateway?.error ?? null;

  return (
    <Bullseye>
      <EmptyState
        titleText={unconfigured ? `${name} is not connectable` : `Connect to ${name}`}
        icon={ConnectedIcon}
        data-testid="openshell-connect-gate"
      >
        <EmptyStateBody>
          {unconfigured
            ? (reason ??
              `${name} did not advertise the OIDC details needed to sign in. Check the gateway's auth configuration.`)
            : `${name} is a separate service with its own sign-in, distinct from your RHOAI login. Sign in to view its workspaces, sandboxes and providers.`}
        </EmptyStateBody>
        <EmptyStateFooter>
          <EmptyStateActions>
            {!unconfigured && (
              <Button
                variant="primary"
                icon={<ConnectedIcon />}
                onClick={doConnect}
                data-testid="openshell-connect-button"
              >
                Connect to {name}
              </Button>
            )}
            {gateway?.consoleUrl && (
              <Button
                variant="link"
                component="a"
                href={gateway.consoleUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open the {name} console
              </Button>
            )}
          </EmptyStateActions>
          {!unconfigured && reason && (
            <EmptyStateBody data-testid="openshell-connect-error">{reason}</EmptyStateBody>
          )}
        </EmptyStateFooter>
      </EmptyState>
    </Bullseye>
  );
};
