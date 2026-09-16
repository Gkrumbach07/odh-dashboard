import {
  agentDeploymentsPath,
  openShellProviderPath,
  openShellSandboxRoute,
} from '~/app/utilities/routes';

describe('agent-ops routes', () => {
  it('builds the canonical provider hierarchy', () => {
    expect(agentDeploymentsPath).toBe('/ai-hub/agents/deployments');
    expect(openShellProviderPath).toBe('/ai-hub/agents/deployments/providers/openshell');
    expect(openShellSandboxRoute('default', 'dev python', 'terminal')).toBe(
      '/ai-hub/agents/deployments/providers/openshell/workspaces/default/sandboxes/dev%20python?tab=terminal',
    );
  });

  describe('openShellSandboxRoute', () => {
    it('omits the tab query when no tab is provided', () => {
      expect(openShellSandboxRoute('default', 'dev-python')).toBe(
        '/ai-hub/agents/deployments/providers/openshell/workspaces/default/sandboxes/dev-python',
      );
    });

    it('encodes workspace and sandbox names', () => {
      expect(openShellSandboxRoute('team 1', 'sandbox/1')).toBe(
        '/ai-hub/agents/deployments/providers/openshell/workspaces/team%201/sandboxes/sandbox%2F1',
      );
    });
  });
});
