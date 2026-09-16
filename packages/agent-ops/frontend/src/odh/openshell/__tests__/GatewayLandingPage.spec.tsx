import * as React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GatewayLandingPage from '~/odh/openshell/GatewayLandingPage';
import {
  useGatewayConnection,
  useGatewayRegistry,
  useSeedGatewayConnections,
  type GatewayRegistryValue,
} from '~/odh/openshell/OpenShellConnection';
import {
  connect,
  type OpenShellConnectionState,
  type OpenShellGateway,
} from '~/odh/openshell/openShellAuth';

jest.mock('~/odh/openshell/OpenShellConnection', () => ({
  useGatewayRegistry: jest.fn(),
  useGatewayConnection: jest.fn(),
  useSeedGatewayConnections: jest.fn(),
}));

jest.mock('~/odh/openshell/openShellAuth', () => ({
  connect: jest.fn(),
}));

const mockUseGatewayRegistry = jest.mocked(useGatewayRegistry);
const mockUseGatewayConnection = jest.mocked(useGatewayConnection);
const mockUseSeedGatewayConnections = jest.mocked(useSeedGatewayConnections);
const mockConnect = jest.mocked(connect);

const IDLE: OpenShellConnectionState = { status: 'disconnected', username: null, error: null };

const gatewayOf = (overrides: Partial<OpenShellGateway> & { id: string }): OpenShellGateway => ({
  name: overrides.id,
  features: {},
  connectable: true,
  ...overrides,
});

const registryOf = (overrides: Partial<GatewayRegistryValue> = {}): GatewayRegistryValue => ({
  gateways: [],
  isLoading: false,
  isRefreshing: false,
  isNotConfigured: false,
  error: null,
  refreshError: null,
  lastUpdated: 1_700_000_000_000,
  reload: jest.fn(),
  ...overrides,
});

/** Connection state per gateway id; anything unnamed is simply disconnected. */
const withConnections = (states: Record<string, OpenShellConnectionState>): void => {
  mockUseGatewayConnection.mockImplementation((gatewayId: string) => states[gatewayId] ?? IDLE);
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <GatewayLandingPage />
    </MemoryRouter>,
  );

describe('GatewayLandingPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    withConnections({});
    mockUseGatewayRegistry.mockReturnValue(registryOf());
  });

  describe('discovered gateways', () => {
    it('should render one card per discovered gateway', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({
          gateways: [
            gatewayOf({ id: 'prod', name: 'Production' }),
            gatewayOf({ id: 'staging', name: 'Staging' }),
            gatewayOf({ id: 'edge', name: 'Edge' }),
          ],
        }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-gateway-card-prod')).toBeInTheDocument();
      expect(screen.getByTestId('openshell-gateway-card-staging')).toBeInTheDocument();
      expect(screen.getByTestId('openshell-gateway-card-edge')).toBeInTheDocument();
      expect(screen.getByText('Production')).toBeInTheDocument();
      expect(screen.getByText('Staging')).toBeInTheDocument();
    });

    it('should show the gateway id alongside the display name', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({ gateways: [gatewayOf({ id: 'openshell-prod', name: 'Production' })] }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-gateway-id-openshell-prod')).toHaveTextContent(
        'openshell-prod',
      );
    });

    it('should fall back to the id when the display name is empty', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({ gateways: [gatewayOf({ id: 'unnamed', name: '' })] }),
      );

      renderPage();

      expect(screen.getByRole('link', { name: 'unnamed' })).toBeInTheDocument();
    });

    it('should render each gateway its own connection status, never a shared one', () => {
      withConnections({
        prod: { status: 'connected', username: 'alice', error: null },
        staging: { status: 'connecting', username: null, error: null },
      });
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({
          gateways: [
            gatewayOf({ id: 'prod' }),
            gatewayOf({ id: 'staging' }),
            gatewayOf({ id: 'edge' }),
          ],
        }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-gateway-status-prod')).toHaveTextContent(
        'Connected as alice',
      );
      expect(screen.getByTestId('openshell-gateway-status-staging')).toHaveTextContent(
        'Connecting',
      );
      expect(screen.getByTestId('openshell-gateway-status-edge')).toHaveTextContent(
        'Not connected',
      );
    });

    it('should show a sign-in failure rather than a disconnected state', () => {
      withConnections({
        prod: { status: 'error', username: null, error: 'Silent renew failed' },
      });
      mockUseGatewayRegistry.mockReturnValue(registryOf({ gateways: [gatewayOf({ id: 'prod' })] }));

      renderPage();

      expect(screen.getByTestId('openshell-gateway-status-prod')).toHaveTextContent(
        'Sign-in failed',
      );
      expect(screen.getByTestId('openshell-gateway-error-prod')).toHaveTextContent(
        'Silent renew failed',
      );
    });

    it('should render the gateway version and the console link', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({
          gateways: [
            gatewayOf({
              id: 'prod',
              gatewayVersion: '1.4.2',
              consoleUrl: 'https://openshell.example.com',
            }),
          ],
        }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-gateway-version-prod')).toHaveTextContent('1.4.2');
      expect(screen.getByTestId('openshell-gateway-console-prod')).toHaveAttribute(
        'href',
        'https://openshell.example.com',
      );
    });

    it('should seed connections for the discovered gateways', () => {
      const gateways = [gatewayOf({ id: 'prod' })];
      mockUseGatewayRegistry.mockReturnValue(registryOf({ gateways }));

      renderPage();

      expect(mockUseSeedGatewayConnections).toHaveBeenCalledWith(gateways);
    });
  });

  describe('connecting to a gateway', () => {
    it('should sign in to the clicked gateway and return into that gateway', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({ gateways: [gatewayOf({ id: 'prod' }), gatewayOf({ id: 'staging' })] }),
      );

      renderPage();
      fireEvent.click(screen.getByTestId('openshell-gateway-connect-staging'));

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledWith(
        'staging',
        '/ai-hub/agents/deployments/gateways/staging',
      );
    });

    it('should offer the gateway instead of a connect button once connected', () => {
      withConnections({ prod: { status: 'connected', username: 'alice', error: null } });
      mockUseGatewayRegistry.mockReturnValue(registryOf({ gateways: [gatewayOf({ id: 'prod' })] }));

      renderPage();

      expect(screen.queryByTestId('openshell-gateway-connect-prod')).not.toBeInTheDocument();
      expect(screen.getByTestId('openshell-gateway-open-prod')).toBeInTheDocument();
    });
  });

  describe('not connectable', () => {
    it('should mark the gateway unavailable, surface the reason and offer no sign-in', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({
          gateways: [
            gatewayOf({
              id: 'broken',
              connectable: false,
              error: 'Gateway did not advertise an OIDC issuer',
            }),
          ],
        }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-gateway-status-broken')).toHaveTextContent(
        'Unavailable',
      );
      expect(screen.getByTestId('openshell-gateway-error-broken')).toHaveTextContent(
        'Gateway did not advertise an OIDC issuer',
      );
      expect(screen.queryByTestId('openshell-gateway-connect-broken')).not.toBeInTheDocument();
    });

    it('should keep unavailable gateways in the list beside usable ones', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({
          gateways: [gatewayOf({ id: 'prod' }), gatewayOf({ id: 'broken', connectable: false })],
        }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-gateway-card-prod')).toBeInTheDocument();
      expect(screen.getByTestId('openshell-gateway-card-broken')).toBeInTheDocument();
      expect(screen.queryByTestId('openshell-no-gateways')).not.toBeInTheDocument();
    });
  });

  describe('warning', () => {
    it('should surface a warning without blocking a connectable gateway', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({
          gateways: [gatewayOf({ id: 'prod', warning: 'Audience is not requested in the scope' })],
        }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-gateway-warning-prod')).toHaveTextContent(
        'Audience is not requested in the scope',
      );
      expect(screen.getByTestId('openshell-gateway-status-prod')).toHaveTextContent(
        'Not connected',
      );
      expect(screen.getByTestId('openshell-gateway-connect-prod')).toBeInTheDocument();
    });
  });

  describe('empty and error states', () => {
    it('should show skeleton cards on the first load', () => {
      mockUseGatewayRegistry.mockReturnValue(registryOf({ isLoading: true, lastUpdated: null }));

      renderPage();

      expect(screen.getAllByTestId('openshell-gateway-card-skeleton')).toHaveLength(3);
      expect(screen.queryByTestId('openshell-no-gateways')).not.toBeInTheDocument();
      expect(screen.queryByTestId('openshell-registry-error')).not.toBeInTheDocument();
    });

    it('should show a calm empty state when discovery found no gateways', () => {
      const reload = jest.fn();
      mockUseGatewayRegistry.mockReturnValue(registryOf({ gateways: [], reload }));

      renderPage();

      expect(screen.getByTestId('openshell-no-gateways')).toBeInTheDocument();
      expect(screen.queryByTestId('openshell-not-configured')).not.toBeInTheDocument();
      expect(screen.queryByTestId('openshell-registry-error')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('openshell-no-gateways-retry'));
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('should distinguish a cluster where OpenShell was never configured', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({ gateways: [], isNotConfigured: true, lastUpdated: null }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-not-configured')).toBeInTheDocument();
      expect(screen.queryByTestId('openshell-no-gateways')).not.toBeInTheDocument();
      expect(screen.queryByTestId('openshell-registry-error')).not.toBeInTheDocument();
    });

    it('should report a registry fetch failure with a retry', () => {
      const reload = jest.fn();
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({ error: 'Could not load OpenShell gateways (500)', reload }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-registry-error')).toHaveTextContent(
        'Could not load OpenShell gateways (500)',
      );
      expect(screen.queryByTestId('openshell-no-gateways')).not.toBeInTheDocument();
      expect(screen.queryByTestId('openshell-not-configured')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('openshell-registry-retry'));
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('should keep the last good list when a refresh fails', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({
          gateways: [gatewayOf({ id: 'prod' })],
          refreshError: 'Network error',
        }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-gateway-card-prod')).toBeInTheDocument();
      expect(screen.getByTestId('openshell-gateways-refresh-error')).toHaveTextContent(
        'Network error',
      );
    });
  });

  describe('refresh', () => {
    it('should reload discovery on demand', () => {
      const reload = jest.fn();
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({ gateways: [gatewayOf({ id: 'prod' })], reload }),
      );

      renderPage();
      fireEvent.click(screen.getByTestId('openshell-gateways-refresh'));

      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('should disable refresh while one is already in flight', () => {
      mockUseGatewayRegistry.mockReturnValue(
        registryOf({ gateways: [gatewayOf({ id: 'prod' })], isRefreshing: true }),
      );

      renderPage();

      expect(screen.getByTestId('openshell-gateways-refresh')).toBeDisabled();
    });
  });
});
