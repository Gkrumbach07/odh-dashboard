export const agentsRootPath = '/ai-hub/agents';
export const agentDeploymentsPath = `${agentsRootPath}/deployments`;

/**
 * Root of the gateway-scoped subtree. Everything below it names exactly one
 * discovered gateway, because a gateway is the only axis left: which install
 * you are looking at.
 */
export const gatewaysPath = `${agentDeploymentsPath}/gateways`;

/**
 * A gateway's own page. The id is the same wire key used everywhere else — the
 * router subtree `/openshell/{id}/`, the client base path, and the per-gateway
 * OIDC storage prefix — so putting it in the URL makes the URL the single
 * source of truth for which gateway is mounted, instead of a re-derived guess.
 *
 * Ids come from an operator-supplied annotation and are not guaranteed to be
 * path-safe, so they are encoded here and decoded by the router's params.
 */
export const gatewayRoute = (gatewayId: string): string =>
  `${gatewaysPath}/${encodeURIComponent(gatewayId)}`;

/**
 * A sandbox inside one gateway's workspace. The gateway id leads, because a
 * workspace name is only unique within a gateway: two installs each with a
 * workspace called "default" would otherwise produce byte-identical URLs and a
 * bookmark would silently open the wrong install's sandbox.
 */
export const openShellSandboxRoute = (
  gatewayId: string,
  workspace: string,
  sandbox: string,
  tab?: string,
): string =>
  `${gatewayRoute(gatewayId)}/workspaces/${encodeURIComponent(
    workspace,
  )}/sandboxes/${encodeURIComponent(sandbox)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`;
