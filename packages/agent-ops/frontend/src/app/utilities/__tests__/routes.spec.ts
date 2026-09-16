import {
  agentDeploymentsPath,
  gatewayRoute,
  gatewaysPath,
  openShellSandboxRoute,
} from '~/app/utilities/routes';

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
});
