import {
  agentDeploymentsPath,
  gatewayRoute,
  gatewaysPath,
  oidcCallbackPath,
  oidcSilentCallbackPath,
  openShellSandboxRoute,
  proxiedBffPathPrefix,
} from '~/app/utilities/routes';
import { OIDC_CALLBACK_PATH, OIDC_SILENT_CALLBACK_PATH } from '~/odh/openshell/openShellAuth';

// openShellAuth pulls in oidc-client-ts, which only opens network calls and
// timers here. Nothing in this file touches a UserManager, so the module is
// stubbed away entirely (virtual: the dependency is declared but the standalone
// workspace does not install it).
jest.mock('oidc-client-ts', () => ({}), { virtual: true });

describe('agent-ops routes', () => {
  it('builds the canonical gateway hierarchy', () => {
    expect(agentDeploymentsPath).toBe('/ai-hub/agents/deployments');
    expect(gatewaysPath).toBe('/ai-hub/agents/deployments/gateways');
    expect(gatewayRoute('prod')).toBe('/ai-hub/agents/deployments/gateways/prod');
    expect(openShellSandboxRoute('prod', 'default', 'dev python', 'terminal')).toBe(
      '/ai-hub/agents/deployments/gateways/prod/workspaces/default/sandboxes/dev%20python?tab=terminal',
    );
  });

  describe('gatewayRoute', () => {
    it('encodes ids that are not path-safe', () => {
      expect(gatewayRoute('team ns/gateway')).toBe(
        '/ai-hub/agents/deployments/gateways/team%20ns%2Fgateway',
      );
    });
  });

  describe('openShellSandboxRoute', () => {
    it('omits the tab query when no tab is provided', () => {
      expect(openShellSandboxRoute('prod', 'default', 'dev-python')).toBe(
        '/ai-hub/agents/deployments/gateways/prod/workspaces/default/sandboxes/dev-python',
      );
    });

    it('encodes gateway, workspace and sandbox names', () => {
      expect(openShellSandboxRoute('east 1', 'team 1', 'sandbox/1')).toBe(
        '/ai-hub/agents/deployments/gateways/east%201/workspaces/team%201/sandboxes/sandbox%2F1',
      );
    });

    it('keeps two gateways with the same workspace name distinguishable', () => {
      expect(openShellSandboxRoute('east', 'default', 'box')).not.toBe(
        openShellSandboxRoute('west', 'default', 'box'),
      );
    });
  });

  describe('OIDC callback paths', () => {
    it('matches the redirect URIs openShellAuth registers with each gateway', () => {
      // The standalone router mounts these two paths; openShellAuth stamps them
      // into every UserManager's redirect_uri/silent_redirect_uri. If the copies
      // ever drift, the IdP sends the browser somewhere nothing is mounted and
      // the sign-in dies on a 404 page with no error of our own.
      expect(oidcCallbackPath).toBe(OIDC_CALLBACK_PATH);
      expect(oidcSilentCallbackPath).toBe(OIDC_SILENT_CALLBACK_PATH);
    });

    it('pins the literal paths a gateway IdP is configured with', () => {
      expect(oidcCallbackPath).toBe('/ai-hub/agents/oidc/callback');
      expect(oidcSilentCallbackPath).toBe('/ai-hub/agents/oidc/silent-callback');
    });

    it('stays outside the reverse-proxied BFF prefix', () => {
      // Under the proxied prefix these would be forwarded to the BFF carrying
      // the IdP's authorization code, and would never resolve in the browser.
      [oidcCallbackPath, oidcSilentCallbackPath].forEach((path) => {
        expect(path).not.toBe(proxiedBffPathPrefix);
        expect(path.startsWith(`${proxiedBffPathPrefix}/`)).toBe(false);
      });
    });
  });
});
