import * as React from 'react';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppRoutes from '~/app/AppRoutes';
import {
  agentDeploymentsPath,
  gatewayRoute,
  oidcCallbackPath,
  oidcSilentCallbackPath,
} from '~/app/utilities/routes';

// The real subtrees pull in openshell-dashboard and oidc-client-ts, neither of
// which this file is testing: what matters here is which path mounts which
// component, so each lazy target is reduced to a marker.
jest.mock('~/odh/openshell/DeploymentsWrapper', () => ({
  __esModule: true,
  default: () => <div data-testid="deployments-wrapper" />,
}));

jest.mock('~/odh/openshell/OpenShellOidcCallback', () => ({
  __esModule: true,
  default: () => <div data-testid="oidc-callback" />,
}));

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );

describe('AppRoutes', () => {
  it('should redirect the root path to the deployments subtree', async () => {
    renderAt('/');
    expect(await screen.findByTestId('deployments-wrapper')).toBeInTheDocument();
  });

  it('should mount the deployments subtree at the deployments path', async () => {
    renderAt(agentDeploymentsPath);
    expect(await screen.findByTestId('deployments-wrapper')).toBeInTheDocument();
  });

  it('should hand nested gateway paths to the deployments subtree', async () => {
    // The subtree owns everything below it — the wildcard must not stop at the
    // gateway list, or a bookmarked gateway page would 404 in standalone.
    renderAt(gatewayRoute('prod'));
    expect(await screen.findByTestId('deployments-wrapper')).toBeInTheDocument();
  });

  it('should mount the OpenShell OIDC redirect callback', async () => {
    // openShellAuth hardcodes this as every gateway's redirect_uri regardless of
    // deployment mode. Without the route the IdP redirect lands on NotFound and
    // the sign-in never completes.
    renderAt(oidcCallbackPath);
    expect(await screen.findByTestId('oidc-callback')).toBeInTheDocument();
  });

  it('should mount the OpenShell OIDC silent-renew callback', async () => {
    renderAt(oidcSilentCallbackPath);
    expect(await screen.findByTestId('oidc-callback')).toBeInTheDocument();
  });

  it('should render not found for an unknown path', async () => {
    renderAt('/nope');
    expect(await screen.findByTestId('not-found-page')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('deployments-wrapper')).not.toBeInTheDocument();
    });
  });
});
