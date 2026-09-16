import * as React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  DeploymentMode,
  useModularArchContext,
  useNamespaceSelector,
  useSettings,
} from 'mod-arch-core';
import { mockUserSettings } from '~/__mocks__/mockUserSettings';
import App from '~/app/App';
import { agentDeploymentsPath, oidcSilentCallbackPath } from '~/app/utilities/routes';

jest.mock('mod-arch-core', () => ({
  ...jest.requireActual('mod-arch-core'),
  useSettings: jest.fn(),
  useNamespaceSelector: jest.fn(),
  useModularArchContext: jest.fn(),
  logout: jest.fn(() => Promise.resolve()),
}));

// The route tree is exercised by AppRoutes.spec.tsx; this file is about what
// App does or does not render it behind.
jest.mock('~/app/AppRoutes', () => ({
  __esModule: true,
  default: () => <div data-testid="app-routes" />,
}));

const mockUseSettings = jest.mocked(useSettings);
const mockUseNamespaceSelector = jest.mocked(useNamespaceSelector);
const mockUseModularArchContext = jest.mocked(useModularArchContext);

const settingsLoaded = (loadError?: Error): ReturnType<typeof useSettings> => ({
  configSettings: { common: { featureFlags: { modelRegistry: false } } },
  userSettings: mockUserSettings({ clusterAdmin: false }),
  loaded: !loadError,
  loadError,
});

const namespaces = (
  overrides: Partial<ReturnType<typeof useNamespaceSelector>> = {},
): ReturnType<typeof useNamespaceSelector> => ({
  namespacesLoaded: true,
  namespacesLoadError: undefined,
  namespaces: [],
  preferredNamespace: undefined,
  updatePreferredNamespace: jest.fn(),
  clearStoredNamespace: jest.fn(),
  initializationError: undefined,
  ...overrides,
});

const renderApp = (path: string = agentDeploymentsPath) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

describe('App', () => {
  beforeEach(() => {
    mockUseSettings.mockReturnValue(settingsLoaded());
    mockUseNamespaceSelector.mockReturnValue(namespaces());
    mockUseModularArchContext.mockReturnValue({
      config: {
        deploymentMode: DeploymentMode.Standalone,
        URL_PREFIX: '/agent-ops',
        BFF_API_VERSION: 'v1',
      },
      namespacesLoaded: true,
      namespaces: [],
      preferredNamespace: undefined,
      updatePreferredNamespace: jest.fn(),
      scriptLoaded: true,
    });
  });

  it('should render the routes once settings have loaded', () => {
    renderApp();
    expect(screen.getByTestId('app-routes')).toBeInTheDocument();
    expect(screen.queryByTestId('project-list-warning')).not.toBeInTheDocument();
  });

  it('should render the routes while the namespace list is still loading', () => {
    // Nothing in the route tree reads namespaces, so waiting on them only delays
    // the gateway UI the shell exists to show.
    mockUseNamespaceSelector.mockReturnValue(namespaces({ namespacesLoaded: false }));
    renderApp();
    expect(screen.getByTestId('app-routes')).toBeInTheDocument();
  });

  it('should render the routes with a warning when listing namespaces fails', () => {
    mockUseNamespaceSelector.mockReturnValue(
      namespaces({
        namespacesLoaded: false,
        namespacesLoadError: new Error('namespaces is forbidden'),
      }),
    );
    renderApp();

    expect(screen.getByTestId('app-routes')).toBeInTheDocument();
    expect(screen.getByTestId('project-list-warning')).toHaveTextContent('namespaces is forbidden');
  });

  it('should warn rather than fail on an initialization error', () => {
    mockUseNamespaceSelector.mockReturnValue(
      namespaces({ initializationError: new Error('no namespace loader') }),
    );
    renderApp();

    expect(screen.getByTestId('app-routes')).toBeInTheDocument();
    expect(screen.getByTestId('project-list-warning')).toHaveTextContent('no namespace loader');
  });

  it('should show the fatal error page when the settings call fails', () => {
    mockUseSettings.mockReturnValue(settingsLoaded(new Error('Error communicating with server')));
    renderApp();

    expect(screen.queryByTestId('app-routes')).not.toBeInTheDocument();
    expect(screen.getByText('Error communicating with server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument();
  });

  it('should show a spinner until settings have loaded', () => {
    mockUseSettings.mockReturnValue({
      configSettings: null,
      userSettings: null,
      loaded: false,
      loadError: undefined,
    });
    renderApp();

    expect(screen.queryByTestId('app-routes')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  describe('on an OpenShell OIDC callback path', () => {
    // The silent renew runs in a hidden iframe that has to post the IdP's
    // response back to the parent tab. A spinner or an error page there never
    // does, so the parent's signinSilent() waits out its own deadline and a live
    // session reports "Sign-in failed" before every token expiry.
    it('should render the routes while settings are still loading', () => {
      mockUseSettings.mockReturnValue({
        configSettings: null,
        userSettings: null,
        loaded: false,
        loadError: undefined,
      });
      renderApp(oidcSilentCallbackPath);

      expect(screen.getByTestId('app-routes')).toBeInTheDocument();
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('should render the routes even when the settings call failed', () => {
      mockUseSettings.mockReturnValue(settingsLoaded(new Error('Error communicating with server')));
      renderApp(oidcSilentCallbackPath);

      expect(screen.getByTestId('app-routes')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Logout' })).not.toBeInTheDocument();
    });
  });
});
