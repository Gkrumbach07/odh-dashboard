import {
  openShellGatewayApiBasePath,
  openShellGatewayRegistryUrl,
  proxiedBffPathPrefix,
} from '~/app/utilities/routes';

/**
 * The OpenShell wire contract, pinned as literals.
 *
 * These paths have to agree with things this repo's type system cannot reach:
 * the module's single module-federation proxy entry in package.json
 * (`{ path: '/agent-ops/api', pathRewrite: '/api' }`) and the BFF's own
 * constants in bff/internal/api/openshell_handler.go. So they are asserted as
 * the strings a browser actually sends, not re-derived from the same constants
 * the code uses — a test built that way agrees with the code wherever it moves.
 */
describe('OpenShell BFF paths', () => {
  it('should send every request under the one reverse-proxied prefix', () => {
    expect(proxiedBffPathPrefix).toBe('/agent-ops/api');
    expect(openShellGatewayRegistryUrl.startsWith(`${proxiedBffPathPrefix}/`)).toBe(true);
    expect(openShellGatewayApiBasePath('prod').startsWith(`${proxiedBffPathPrefix}/`)).toBe(true);
  });

  it('should ask for the gateway registry on our own versioned endpoint', () => {
    // Browser /agent-ops/api/v1/openshell/gateways -> BFF /api/v1/openshell/gateways.
    expect(openShellGatewayRegistryUrl).toBe('/agent-ops/api/v1/openshell/gateways');
  });

  it('should base a gateway tunnel on the gateway id, unversioned', () => {
    // Browser /agent-ops/api/openshell/{id}/... -> BFF /api/openshell/{id}/...,
    // where the BFF splits {id} back off and the rest is the gateway's OWN API.
    // No /v1 here on purpose: stamping a RHOAI API version on another service's
    // contract would claim a compatibility promise we cannot keep.
    expect(openShellGatewayApiBasePath('prod')).toBe('/agent-ops/api/openshell/prod');
  });

  it('should keep the registry out of the tunnel subtree', () => {
    // The load-bearing one. Derive the registry from the tunnel prefix and it
    // becomes /agent-ops/api/openshell/gateways, which the tunnel mount happily
    // serves as the gateway whose id is "gateways" — a silent wrong answer.
    const tunnelRoot = openShellGatewayApiBasePath('');
    expect(openShellGatewayRegistryUrl.startsWith(tunnelRoot)).toBe(false);
  });
});
