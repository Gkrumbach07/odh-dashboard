import * as React from 'react';
import {
  Button,
  Bullseye,
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
  Spinner,
} from '@patternfly/react-core';
import { ConnectedIcon, DisconnectedIcon, ExclamationCircleIcon } from '@patternfly/react-icons';
import { setApiBasePath, setAuthTokenGetter, setAuthTokenHeader } from 'openshell-dashboard/api';
import {
  connect,
  disconnect,
  fetchGateways,
  getToken,
  initConnection,
  registerGateway,
  subscribeConnection,
  OPENSHELL_AUTH_HEADER,
  OPENSHELL_SESSION_EXPIRED_EVENT,
  type OpenShellConnectionState,
  type OpenShellGateway,
} from './openShellAuth';

// ─── Registry ────────────────────────────────────────────────────────────────
// Which OpenShell installs exist, and what each says about its identity domain.
// Shared across the whole OpenShell area; the switcher reads it.

type GatewayRegistryValue = {
  gateways: OpenShellGateway[];
  isLoading: boolean;
  error: string | null;
  reload: () => void;
};

const GatewayRegistryContext = React.createContext<GatewayRegistryValue>({
  gateways: [],
  isLoading: true,
  error: null,
  reload: () => undefined,
});

export const useGatewayRegistry = (): GatewayRegistryValue =>
  React.useContext(GatewayRegistryContext);

export const GatewayRegistryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [gateways, setGateways] = React.useState<OpenShellGateway[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetchGateways()
      .then((found) => {
        if (cancelled) {
          return;
        }
        found.forEach(registerGateway);
        setGateways(found);
        setError(null);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const value = React.useMemo<GatewayRegistryValue>(
    () => ({ gateways, isLoading, error, reload: () => setNonce((n) => n + 1) }),
    [gateways, isLoading, error],
  );

  return (
    <GatewayRegistryContext.Provider value={value}>{children}</GatewayRegistryContext.Provider>
  );
};

// ─── Active gateway ──────────────────────────────────────────────────────────
// Sessions are held for every connected gateway at once, but exactly one gateway
// is mounted at a time. That is what keeps the npm package's module-level client
// config (base path, token getter) valid without teaching it about gateways.

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
  const boundRef = React.useRef<string | null>(null);
  if (boundRef.current !== gatewayId) {
    setApiBasePath(`/openshell/${gatewayId}`);
    setAuthTokenHeader(OPENSHELL_AUTH_HEADER);
    setAuthTokenGetter(() => getToken(gatewayId));
    boundRef.current = gatewayId;
  }

  const [state, setState] = React.useState<OpenShellConnectionState>({
    status: 'idle',
    username: null,
    error: null,
  });

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
  }, [gatewayId, gateway]);

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

type GatewaySwitcherProps = {
  gatewayId: string;
  onSelect: (gatewayId: string) => void;
};

export const GatewaySwitcher: React.FC<GatewaySwitcherProps> = ({ gatewayId, onSelect }) => {
  const { gateways, isLoading } = useGatewayRegistry();
  const [isOpen, setIsOpen] = React.useState(false);

  if (isLoading || gateways.length < 2) {
    return null;
  }

  const active = gateways.find((g) => g.id === gatewayId);

  return (
    <Select
      isOpen={isOpen}
      selected={gatewayId}
      onOpenChange={setIsOpen}
      onSelect={(_event, value) => {
        setIsOpen(false);
        if (typeof value === 'string' && value !== gatewayId) {
          onSelect(value);
        }
      }}
      toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
        <MenuToggle
          ref={toggleRef}
          isExpanded={isOpen}
          onClick={() => setIsOpen((open) => !open)}
          data-testid="openshell-gateway-switcher"
        >
          {active?.name ?? gatewayId}
        </MenuToggle>
      )}
    >
      <SelectList>
        {gateways.map((g) => (
          <SelectOption
            key={g.id}
            value={g.id}
            description={g.connectable ? undefined : (g.error ?? 'Not connectable')}
            isDisabled={!g.connectable}
          >
            {g.name}
          </SelectOption>
        ))}
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

  return (
    <Bullseye>
      <EmptyState
        titleText={unconfigured ? `${name} is not connectable` : `Connect to ${name}`}
        icon={ConnectedIcon}
        data-testid="openshell-connect-gate"
      >
        <EmptyStateBody>
          {unconfigured
            ? `${name} did not advertise the OIDC details needed to sign in. Check the gateway's auth configuration.`
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
          {(state.error ?? gateway?.error) && (
            <EmptyStateBody data-testid="openshell-connect-error">
              {state.error ?? gateway?.error}
            </EmptyStateBody>
          )}
        </EmptyStateFooter>
      </EmptyState>
    </Bullseye>
  );
};
