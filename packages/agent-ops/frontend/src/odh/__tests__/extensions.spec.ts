import { proxiedBffPathPrefix } from '~/app/utilities/routes';
import extensions from '~/odh/extensions';

const AGENT_OPS = 'agent-ops';

const tabs = () => extensions.filter((e) => e.type === 'app.tab-route/tab');
const routes = () => extensions.filter((e) => e.type === 'app.route');
const findTab = (id: string) => tabs().find((e) => e.properties.id === id);
const routePaths = () => routes().map((e) => e.properties.path);

describe('agent-ops extensions', () => {
  it('should register the agent ops area with feature flag', () => {
    const area = extensions.find(
      (extension) => extension.type === 'app.area' && extension.properties.id === AGENT_OPS,
    );
    expect(area).toMatchObject({
      type: 'app.area',
      properties: {
        id: AGENT_OPS,
        featureFlags: ['agentOps'],
      },
    });
  });

  it('contributes one canonical Deployments tab', () => {
    expect(tabs()).toHaveLength(1);
    const deployments = findTab('deployments');
    expect(deployments).toMatchObject({
      type: 'app.tab-route/tab',
      flags: { required: [AGENT_OPS] },
      properties: {
        pageId: 'agents-tab-page',
        id: 'deployments',
        title: 'Deployments',
        group: '1_deployments',
      },
    });
  });

  it('does not register provider or workspace pages as standalone routes', () => {
    expect(routePaths()).toEqual([
      '/ai-hub/agents/oidc/callback',
      '/ai-hub/agents/oidc/silent-callback',
    ]);
  });

  it('registers the OpenShell OIDC callback routes outside the proxied BFF prefix', () => {
    const paths = routePaths();
    expect(paths).toContain('/ai-hub/agents/oidc/callback');
    expect(paths).toContain('/ai-hub/agents/oidc/silent-callback');

    // The module reverse-proxies exactly one prefix to its BFF, and this is it.
    // Pinned to the literal as well as the derived value: the point of the
    // assertion is the real wire prefix, and a test that only compared a
    // constant to itself would still pass if that constant moved.
    expect(proxiedBffPathPrefix).toBe('/agent-ops/api');

    // Callbacks must stay SPA routes. Under the proxied prefix they would be
    // forwarded to the BFF with the IdP's authorization code in the query
    // string, and the sign-in would never complete in the browser.
    const callbacks = paths.filter((p) => p.includes('/oidc/'));
    expect(callbacks).not.toHaveLength(0);
    callbacks.forEach((p) => {
      expect(p.startsWith(`${proxiedBffPathPrefix}/`)).toBe(false);
      expect(p).not.toBe(proxiedBffPathPrefix);
    });
  });
});
