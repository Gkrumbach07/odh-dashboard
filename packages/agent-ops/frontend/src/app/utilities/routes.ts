export const agentsRootPath = '/ai-hub/agents';
export const agentDeploymentsPath = `${agentsRootPath}/deployments`;
export const openShellProviderPath = `${agentDeploymentsPath}/providers/openshell`;

export const openShellSandboxRoute = (workspace: string, sandbox: string, tab?: string): string =>
  `${openShellProviderPath}/workspaces/${encodeURIComponent(workspace)}/sandboxes/${encodeURIComponent(
    sandbox,
  )}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`;
