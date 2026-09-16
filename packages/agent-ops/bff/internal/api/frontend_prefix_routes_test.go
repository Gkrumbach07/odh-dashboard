package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opendatahub-io/mod-arch-library/bff/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The browser always calls /agent-ops/api/...: mod-arch-core builds exactly one
// URL shape and has no deployment-mode branch. Federated, the dashboard's module
// proxy strips the prefix; standalone, nothing is in front of the BFF, so these
// mounts strip it instead. Before them, standalone requests fell through to the
// SPA catch-all and came back as index.html with a 200 — a "successful" response
// the frontend waits on forever.
//
// Every assertion here is that the alias is INDISTINGUISHABLE from the stripped
// path, not merely that it answers: an alias that reaches the same handler by a
// different route (skipping identity, skipping the credential swap) is worse
// than one that 404s, because nothing visibly fails.

// frontendPrefixed returns the path as the browser sends it.
func frontendPrefixed(path string) string { return FrontendPathPrefix + path }

// TestFrontendPrefixIsTheOnlyUrlTheBrowserNeeds pins the prefix itself. It is
// duplicated in this package's package.json (module-federation.proxy[].path),
// which is what performs the strip in federated mode; renaming one side alone
// silently splits the two modes apart again.
func TestFrontendPrefixIsTheOnlyUrlTheBrowserNeeds(t *testing.T) {
	assert.Equal(t, "/agent-ops", FrontendPathPrefix,
		"must match module-federation.proxy[].path in packages/agent-ops/package.json")
	assert.Contains(t, apiMountPrefixes, FrontendPathPrefix,
		"the mux mounts and the identity gate both read this list")
}

// The two OpenShell surfaces have to keep their split under the alias too. They
// are one typo apart under /api already; adding a second spelling doubles the
// chances of the tunnel swallowing the registry.
func TestFrontendPrefixReachesBothOpenShellSurfaces(t *testing.T) {
	var sawID, sawRest string
	routes := newRoutedTestApp(t,
		config.EnvConfig{AuthMethod: config.AuthMethodDisabled},
		openShellTestFleet(t, &sawID, &sawRest, nil))

	t.Run("the registry is served by the registry handler", func(t *testing.T) {
		sawID, sawRest = "", ""
		rr := httptest.NewRecorder()
		routes.ServeHTTP(rr, httptest.NewRequest(http.MethodGet,
			frontendPrefixed(OpenShellGatewaysPath), nil))

		require.Equal(t, http.StatusOK, rr.Code, "body: %s", rr.Body.String())
		// Asserting on the decoded payload, not the status: the failure this
		// guards against is the SPA catch-all answering index.html with a 200.
		var body struct {
			Gateways []GatewayView `json:"gateways"`
		}
		require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
		assert.Empty(t, body.Gateways)
		assert.Empty(t, sawID, "the registry request must not have been dispatched down the tunnel")
	})

	t.Run("the tunnel splits off the id and hands the gateway its own path", func(t *testing.T) {
		sawID, sawRest = "", ""
		rr := httptest.NewRecorder()
		routes.ServeHTTP(rr, httptest.NewRequest(http.MethodGet,
			frontendPrefixed(OpenShellPathPrefix+"/prod/api/v1/workspaces"), nil))

		require.Equal(t, teapot, rr.Code, "body: %s", rr.Body.String())
		assert.Equal(t, "prod", sawID)
		// The module prefix AND the tunnel prefix AND the id are all gone: the
		// gateway must see precisely what it sees on the federated path, or the
		// two modes address different upstream URLs.
		assert.Equal(t, "/api/v1/workspaces", sawRest)
	})

	t.Run("the tunnel alias does not answer the registry", func(t *testing.T) {
		sawID, sawRest = "", ""
		rr := httptest.NewRecorder()
		routes.ServeHTTP(rr, httptest.NewRequest(http.MethodGet,
			frontendPrefixed(OpenShellPathPrefix+"/gateways"), nil))

		// "gateways" reads as a gateway id here, exactly as it does unprefixed.
		require.Equal(t, http.StatusNotFound, rr.Code)
		assert.NotContains(t, rr.Body.String(), `"gateways"`,
			"the registry must not be reachable under the tunnel's prefix")
		assert.Empty(t, sawID)
	})
}

// The tunnel dispatches identically no matter which spelling it arrived on —
// asserted side by side so a divergence shows up as a disagreement between two
// rows rather than as a missing test nobody wrote.
func TestTunnelDispatchIsIdenticalOnBothSpellings(t *testing.T) {
	for _, tc := range []struct {
		name string
		url  string
	}{
		{"federated (dashboard already stripped the module prefix)", OpenShellPathPrefix + "/prod/deep/path?q=1"},
		{"standalone (this BFF strips it)", frontendPrefixed(OpenShellPathPrefix + "/prod/deep/path?q=1")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var sawID, sawRest string
			routes := newRoutedTestApp(t,
				config.EnvConfig{AuthMethod: config.AuthMethodDisabled},
				openShellTestFleet(t, &sawID, &sawRest, nil))

			rr := httptest.NewRecorder()
			routes.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, tc.url, nil))

			require.Equal(t, teapot, rr.Code, "body: %s", rr.Body.String())
			assert.Equal(t, "prod", sawID)
			assert.Equal(t, "/deep/path", sawRest)
		})
	}
}

// The trust boundary on the new alias.
//
// A leak already shipped out of this seam once, because the tests exercised
// swapToOpenShellToken directly and so could not notice a dispatch path that
// never invoked it. A second mount is a second dispatch path: it has to be
// driven through app.Routes() for the assertion to mean anything.
func TestPlatformCredentialsNeverReachAGatewayViaTheFrontendPrefix(t *testing.T) {
	const (
		platformToken  = "TOKEN-A-openshift-replayable-against-the-cluster"
		openShellToken = "TOKEN-B-scoped-to-this-gateway"
	)

	var sawID, sawRest string
	var sawHeader http.Header
	routes := newRoutedTestApp(t,
		config.EnvConfig{AuthMethod: config.AuthMethodDisabled},
		openShellTestFleet(t, &sawID, &sawRest, &sawHeader))

	req := httptest.NewRequest(http.MethodGet,
		frontendPrefixed(OpenShellPathPrefix+"/prod/api/v1/workspaces"), nil)
	// Everything the RHOAI hops in front of this BFF can put on a request.
	req.Header.Set("Authorization", "Bearer "+platformToken)
	req.Header.Set("X-Forwarded-Access-Token", platformToken)
	req.Header.Set("X-Auth-Request-Access-Token", platformToken)
	req.Header.Set("X-Auth-Request-User", "victim")
	req.Header.Set("X-Auth-Request-Email", "victim@example.com")
	req.Header.Set("X-Auth-Request-Groups", "system:authenticated")
	req.Header.Set("Cookie", "_oauth_proxy=rhoai-session")
	req.Header.Set(OpenShellAuthHeader, "Bearer "+openShellToken)

	rr := httptest.NewRecorder()
	routes.ServeHTTP(rr, req)
	require.Equal(t, teapot, rr.Code, "body: %s", rr.Body.String())
	require.NotNil(t, sawHeader, "the gateway-side handler never ran")

	// Swept over every header rather than the ones we remembered to name: an
	// enumerated assertion only catches the leaks someone already thought of,
	// which is how X-Auth-Request-Access-Token survived the first swap.
	for name, values := range sawHeader {
		for _, v := range values {
			assert.NotContains(t, v, platformToken,
				"header %q carried the platform token to the gateway", name)
		}
	}
	assert.Empty(t, sawHeader.Get("Cookie"), "the RHOAI session cookie must not reach the gateway")

	// Destroyed AND projected: the gateway must still receive its own token, or
	// the swap would "pass" by forwarding nothing at all.
	assert.Equal(t, "Bearer "+openShellToken, sawHeader.Get("Authorization"))
	assert.Equal(t, openShellToken, sawHeader.Get("X-Forwarded-Access-Token"))
	assert.Empty(t, sawHeader.Get(OpenShellAuthHeader),
		"the carrier header is consumed at the boundary, not forwarded")
}

// InjectRequestIdentity wraps the outer mux, so it runs BEFORE StripPrefix and
// matches on the unstripped path. An alias the gate does not know about is not a
// 404 — it is the same endpoint, reachable without a token, under a second name.
//
// Driven off apiMountPrefixes itself so this cannot fall behind: a prefix added
// to that list is mounted AND asserted here by the same edit.
func TestEveryApiMountPrefixIsIdentityGated(t *testing.T) {
	for _, prefix := range apiMountPrefixes {
		name := prefix
		if name == "" {
			name = "(bare)"
		}
		t.Run(name, func(t *testing.T) {
			var sawID, sawRest string
			routes := newRoutedTestApp(t, config.EnvConfig{
				AuthMethod:      config.AuthMethodUser,
				AuthTokenHeader: "Authorization",
				AuthTokenPrefix: "Bearer ",
			}, openShellTestFleet(t, &sawID, &sawRest, nil))

			url := prefix + OpenShellGatewaysPath

			t.Run("without an identity it is refused", func(t *testing.T) {
				rr := httptest.NewRecorder()
				routes.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, url, nil))
				assert.Equal(t, http.StatusUnauthorized, rr.Code,
					"%s reached a handler with no caller identity", url)
			})

			t.Run("with an identity it reaches the api router", func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, url, nil)
				req.Header.Set("Authorization", "Bearer some-openshift-token")
				rr := httptest.NewRecorder()
				routes.ServeHTTP(rr, req)

				require.Equal(t, http.StatusOK, rr.Code, "body: %s", rr.Body.String())
				// Decoded, so an index.html body with a 200 from the SPA
				// catch-all cannot pass as a served API response.
				var body struct {
					Gateways []GatewayView `json:"gateways"`
				}
				require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body),
					"%s did not reach the API router", url)
				assert.Empty(t, body.Gateways)
			})
		})
	}
}

// FrontendPathPrefix has to equal the module-federation proxy path declared in
// packages/agent-ops/package.json, and nothing in either language can express
// that. The two are the same fact written in two files: the dashboard strips
// whatever package.json names, and this BFF strips FrontendPathPrefix. Rename
// one and federated mode routes to a prefix the BFF does not answer — which
// compiles, lints and passes every other test, because a Go constant and a JSON
// string have no reason to be compared unless someone writes this down.
//
// Read at test time rather than generated, so the check costs nothing at runtime
// and cannot drift from the file it is asserting about.
func TestFrontendPathPrefixMatchesTheDeclaredProxyEntry(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "package.json"))
	require.NoError(t, err, "package.json is the other half of this contract")

	var pkg struct {
		ModuleFederation struct {
			Proxy []struct {
				Path        string `json:"path"`
				PathRewrite string `json:"pathRewrite"`
			} `json:"proxy"`
		} `json:"module-federation"`
	}
	require.NoError(t, json.Unmarshal(raw, &pkg))

	// One entry, like every other module in the monorepo. A second would mean
	// agent-ops had grown another top-level path outside its own prefix, which
	// is the shape this module was just moved away from.
	require.Len(t, pkg.ModuleFederation.Proxy, 1,
		"agent-ops declares exactly one module-federation proxy entry")

	entry := pkg.ModuleFederation.Proxy[0]

	// What the browser sends is the prefix this BFF strips, plus the root the
	// dashboard rewrites onto. Asserted structurally AND as literals: compared
	// only against each other, both halves could move together and still agree
	// while no longer matching the URL mod-arch-core actually builds.
	assert.Equal(t, FrontendPathPrefix+entry.PathRewrite, entry.Path,
		"the proxied path must be the prefix this BFF strips plus the path it mounts on")
	assert.Equal(t, "/agent-ops/api", entry.Path)
	assert.Equal(t, "/api", entry.PathRewrite)

	// And the rewrite target has to be where apiRouter actually lives, or the
	// dashboard hands this BFF a path nothing is mounted on.
	assert.True(t, strings.HasPrefix(ApiPathPrefix, entry.PathRewrite+"/"),
		"apiRouter mounts under %q, which must sit beneath the rewrite target %q",
		ApiPathPrefix, entry.PathRewrite)
}
