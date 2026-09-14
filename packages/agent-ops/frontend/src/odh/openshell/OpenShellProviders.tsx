import * as React from 'react';
import { Bullseye, EmptyState, EmptyStateBody, Spinner } from '@patternfly/react-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AlertProvider } from 'openshell-dashboard/components';
import { SlotProvider } from 'openshell-dashboard/slots';
import { setSessionExpiredHandler } from 'openshell-dashboard/api';
import { OPENSHELL_SESSION_EXPIRED_EVENT } from './openShellAuth';
import {
  ActiveGatewayProvider,
  GatewayRegistryProvider,
  OpenShellConnectGate,
  useGatewayRegistry,
} from './OpenShellConnection';
import { SelectedWorkspaceProvider } from './WorkspaceContext';

// The OpenShell session is independent of the RHOAI session. A hard redirect to
// '/' would tear down the whole dashboard for a *second-service* expiry, so this
// emits a non-destructive event the active gateway listens for instead.
setSessionExpiredHandler(() => {
  window.dispatchEvent(new CustomEvent(OPENSHELL_SESSION_EXPIRED_EVENT));
});

// One QueryClient per gateway. Query keys carry no gateway dimension
// (['sandboxes', workspace, …]), so two gateways each with a workspace named
// "default" would collide in a shared cache. Separate clients isolate them
// without teaching the npm package about gateways.
const queryClients = new Map<string, QueryClient>();

const queryClientFor = (gatewayId: string): QueryClient => {
  const existing = queryClients.get(gatewayId);
  if (existing) {
    return existing;
  }
  const created = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
    },
  });
  queryClients.set(gatewayId, created);
  return created;
};

type OpenShellProvidersProps = {
  children: React.ReactNode;
  /** Which install to mount. Defaults to the first connectable one. */
  gatewayId?: string;
  requireConnection?: boolean;
};

const ResolvedGateway: React.FC<
  Required<Pick<OpenShellProvidersProps, 'children'>> & {
    gatewayId?: string;
    requireConnection: boolean;
  }
> = ({ children, gatewayId, requireConnection }) => {
  const { gateways, isLoading, error } = useGatewayRegistry();

  if (isLoading) {
    return (
      <Bullseye>
        <Spinner aria-label="Loading OpenShell gateways" />
      </Bullseye>
    );
  }

  if (error) {
    return (
      <Bullseye>
        <EmptyState
          titleText="Could not load OpenShell gateways"
          data-testid="openshell-registry-error"
        >
          <EmptyStateBody>{error}</EmptyStateBody>
        </EmptyState>
      </Bullseye>
    );
  }

  if (gateways.length === 0) {
    return (
      <Bullseye>
        <EmptyState titleText="No OpenShell gateways" data-testid="openshell-no-gateways">
          <EmptyStateBody>
            This deployment has no OpenShell installs configured. Ask a cluster administrator to
            register one.
          </EmptyStateBody>
        </EmptyState>
      </Bullseye>
    );
  }

  const requested = gatewayId ? gateways.find((g) => g.id === gatewayId) : undefined;
  const resolved = requested ?? gateways.find((g) => g.connectable) ?? gateways[0];

  if (gatewayId && !requested) {
    return (
      <Bullseye>
        <EmptyState titleText="Unknown gateway" data-testid="openshell-unknown-gateway">
          <EmptyStateBody>
            No OpenShell gateway named &quot;{gatewayId}&quot; is configured for this deployment.
          </EmptyStateBody>
        </EmptyState>
      </Bullseye>
    );
  }

  return (
    // Keyed so every per-gateway hook, context and cache resets on a switch
    // rather than briefly showing the previous gateway's data.
    <React.Fragment key={resolved.id}>
      <QueryClientProvider client={queryClientFor(resolved.id)}>
        <ActiveGatewayProvider gatewayId={resolved.id}>
          <SlotProvider slots={{}}>
            <AlertProvider>
              <SelectedWorkspaceProvider>
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
    </React.Fragment>
  );
};

const OpenShellProviders: React.FC<OpenShellProvidersProps> = ({
  children,
  gatewayId,
  requireConnection = true,
}) => (
  <GatewayRegistryProvider>
    <ResolvedGateway gatewayId={gatewayId} requireConnection={requireConnection}>
      {children}
    </ResolvedGateway>
  </GatewayRegistryProvider>
);

export default OpenShellProviders;
