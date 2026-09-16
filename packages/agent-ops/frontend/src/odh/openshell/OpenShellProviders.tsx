import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Bullseye,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Spinner,
} from '@patternfly/react-core';
import { ExclamationCircleIcon } from '@patternfly/react-icons';
import { QueryClientProvider } from '@tanstack/react-query';
import { AlertProvider } from 'openshell-dashboard/components';
import { SlotProvider } from 'openshell-dashboard/slots';
import { setSessionExpiredHandler } from 'openshell-dashboard/api';
import { OPENSHELL_SESSION_EXPIRED_EVENT, type OpenShellGateway } from './openShellAuth';
import {
  ActiveGatewayProvider,
  OpenShellConnectGate,
  useGatewayRegistry,
} from './OpenShellConnection';
import { SelectedWorkspaceProvider } from './WorkspaceContext';
import { DEPLOYMENTS_PATH } from './gatewayRoutes';
import { queryClientFor } from './gatewayQueryClients';

// The OpenShell session is independent of the RHOAI session. A hard redirect to
// '/' would tear down the whole dashboard for a *second-service* expiry, so this
// emits a non-destructive event the active gateway listens for instead.
setSessionExpiredHandler(() => {
  window.dispatchEvent(new CustomEvent(OPENSHELL_SESSION_EXPIRED_EVENT));
});

type OpenShellProvidersProps = {
  children: React.ReactNode;
  /**
   * Which install to mount. Required, and always the :gatewayId route segment:
   * the URL is the only thing allowed to decide which gateway is current.
   */
  gatewayId: string;
  requireConnection?: boolean;
};

const ResolvedGateway: React.FC<{
  children: React.ReactNode;
  gatewayId: string;
  requireConnection: boolean;
}> = ({ children, gatewayId, requireConnection }) => {
  const { gateways, isLoading, error, reload } = useGatewayRegistry();

  const discovered = React.useMemo(
    () => gateways.find((g) => g.id === gatewayId) ?? null,
    [gateways, gatewayId],
  );

  // Last answer discovery gave for THIS id. Gateways are found on the cluster
  // and the set changes at runtime, so a gateway can drop out of a sweep while
  // someone is mid-interaction inside it. Tearing the subtree down at that
  // moment would close an open sandbox detail over a background poll, so the
  // page stays up on the last known description and says what happened instead.
  // This component is keyed by gatewayId, so the retention never leaks across a
  // switch.
  const lastKnownRef = React.useRef<OpenShellGateway | null>(null);
  if (discovered) {
    lastKnownRef.current = discovered;
  }
  const retained = lastKnownRef.current;
  const hasVanished = !discovered && retained !== null;

  // Nothing to resolve against yet. Only ever shown before the first answer —
  // later polls refresh over whatever is already on screen.
  if (isLoading && !retained) {
    return (
      <Bullseye>
        <Spinner aria-label="Loading agent gateways" />
      </Bullseye>
    );
  }

  if (error && !retained) {
    return (
      <Bullseye>
        <EmptyState
          titleText="Can't load agent gateways"
          icon={ExclamationCircleIcon}
          data-testid="openshell-registry-error"
        >
          <EmptyStateBody>{error}</EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="primary" onClick={reload}>
                Try again
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      </Bullseye>
    );
  }

  if (!retained) {
    // The URL names a gateway discovery has never reported. Say the name back
    // rather than quietly mounting a different install: an id that does not
    // resolve is a bookmark to fix or a gateway to ask an administrator about.
    return (
      <Bullseye>
        <EmptyState
          titleText="Unknown gateway"
          icon={ExclamationCircleIcon}
          data-testid="openshell-unknown-gateway"
        >
          <EmptyStateBody>
            No agent gateway named &quot;{gatewayId}&quot; was discovered in this cluster. It may
            have been removed, or the link may be out of date.
          </EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button
                variant="primary"
                component={(props) => <Link {...props} to={DEPLOYMENTS_PATH} />}
              >
                View all gateways
              </Button>
              <Button variant="link" onClick={reload}>
                Check again
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      </Bullseye>
    );
  }

  return (
    <QueryClientProvider client={queryClientFor(gatewayId)}>
      <ActiveGatewayProvider gatewayId={gatewayId}>
        <SlotProvider slots={{}}>
          <AlertProvider>
            <SelectedWorkspaceProvider>
              {hasVanished ? (
                <Alert
                  variant="warning"
                  isInline
                  title={`${retained.name || gatewayId} is no longer being discovered in this cluster`}
                  data-testid="openshell-gateway-vanished"
                >
                  You can keep working with what is already open, but new requests may fail. Return
                  to all gateways to see what is available now.
                </Alert>
              ) : null}
              {requireConnection ? (
                <OpenShellConnectGate>{children}</OpenShellConnectGate>
              ) : (
                children
              )}
            </SelectedWorkspaceProvider>
          </AlertProvider>
        </SlotProvider>
      </ActiveGatewayProvider>
    </QueryClientProvider>
  );
};

const OpenShellProviders: React.FC<OpenShellProvidersProps> = ({
  children,
  gatewayId,
  requireConnection = true,
}) => (
  // Keyed so every per-gateway hook, context, cache and the vanished-gateway
  // retention above reset on a switch, rather than briefly showing the previous
  // gateway's data under the new gateway's URL.
  <ResolvedGateway key={gatewayId} gatewayId={gatewayId} requireConnection={requireConnection}>
    {children}
  </ResolvedGateway>
);

export default OpenShellProviders;
