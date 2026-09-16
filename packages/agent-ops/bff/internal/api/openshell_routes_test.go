package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opendatahub-io/mod-arch-library/bff/internal/config"
	k8s "github.com/opendatahub-io/mod-arch-library/bff/internal/integrations/kubernetes"
	"github.com/opendatahub-io/mod-arch-library/bff/internal/repositories"
	"github.com/opendatahub-io/mod-arch-library/bff/pkg/fleet"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// teapot is a status no handler in this BFF returns on its own, so seeing it
// proves the request reached the stub gateway handler and nothing else.
const teapot = http.StatusTeapot

type stubLookup map[string]fleet.Backend

func (s stubLookup) Lookup(id string) (fleet.Backend, bool) {
	b, ok := s[id]
	return b, ok
}

// openShellTestFleet is a fleet whose tunnel router dispatches to a recording
// handler. registry stays nil on purpose: Views tolerates that and returns an
// empty list, which is all the registry endpoint needs in order to be
// identifiable in a response.
//
// The router is built by the PRODUCTION constructor and only its terminal pieces
// are overridden. Hand-rolling a fleet.Router literal here would silently drop
// whatever newRouter sets — Rewrite above all, which is the trust boundary — and
// a test that omits the credential swap cannot notice the swap being deleted.
// That is exactly how the original leak shipped: the tests exercised the swap
// helper directly instead of the wiring that installs it.
func openShellTestFleet(t *testing.T, sawID, sawRest *string, sawHeader *http.Header) *OpenShellFleet {
	t.Helper()
	f := &OpenShellFleet{logger: testAppLogger()}
	r := f.newRouter()
	r.Backends = stubLookup{"prod": {ID: "prod", Name: "Production"}}
	r.Readiness = nil
	r.Handlers = func(b fleet.Backend) (http.Handler, error) {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			*sawID, *sawRest = b.ID, req.URL.Path
			if sawHeader != nil {
				*sawHeader = req.Header.Clone()
			}
			w.WriteHeader(teapot)
		}), nil
	}
	f.router = r
	return f
}

func newRoutedTestApp(t *testing.T, cfg config.EnvConfig, f *OpenShellFleet) http.Handler {
	t.Helper()
	cfg.StaticAssetsDir = t.TempDir()
	app := &App{
		config:       cfg,
		logger:       testAppLogger(),
		repositories: repositories.NewRepositories(),
		openShell:    f,
	}
	if cfg.AuthMethod != config.AuthMethodDisabled {
		app.kubernetesClientFactory = k8s.NewTokenClientFactory(testAppLogger(), cfg)
	}
	return app.Routes()
}

// The registry and the tunnel are two mounts that look alike and are one typo
// apart. If OpenShellGatewaysPath were derived from OpenShellPathPrefix the
// registry would land at /api/openshell/gateways, where the tunnel mount
// swallows it and answers it as gateway id "gateways" — a 404 in place of the
// list the frontend needs, with nothing at the mount site to show why. This
// exercises the real route tree from app.Routes() so the two cannot silently
// swap or shadow each other.
func TestOpenShellMountsDoNotShadowEachOther(t *testing.T) {
	var sawID, sawRest string
	routes := newRoutedTestApp(t,
		config.EnvConfig{AuthMethod: config.AuthMethodDisabled},
		openShellTestFleet(t, &sawID, &sawRest, nil))

	t.Run("the registry is served by the registry handler, on apiRouter", func(t *testing.T) {
		sawID, sawRest = "", ""
		rr := httptest.NewRecorder()
		routes.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, OpenShellGatewaysPath, nil))

		require.Equal(t, http.StatusOK, rr.Code, "body: %s", rr.Body.String())
		var body struct {
			Gateways []GatewayView `json:"gateways"`
		}
		require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
		assert.Empty(t, body.Gateways)
		assert.Empty(t, sawID, "the registry request must not have been dispatched down the tunnel")
	})

	t.Run("the tunnel is served by the fleet router, keyed by gateway id", func(t *testing.T) {
		sawID, sawRest = "", ""
		rr := httptest.NewRecorder()
		routes.ServeHTTP(rr, httptest.NewRequest(http.MethodGet,
			OpenShellPathPrefix+"/prod/api/v1/workspaces", nil))

		require.Equal(t, teapot, rr.Code, "body: %s", rr.Body.String())
		assert.Equal(t, "prod", sawID)
		// The whole multi-segment prefix plus the id is stripped; the gateway
		// sees its own unversioned path, not ours.
		assert.Equal(t, "/api/v1/workspaces", sawRest)
	})

	t.Run("the tunnel owns /api/openshell/* and never answers the registry there", func(t *testing.T) {
		sawID, sawRest = "", ""
		rr := httptest.NewRecorder()
		routes.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, OpenShellPathPrefix+"/gateways", nil))

		// "gateways" is read as a gateway id, and there is no such gateway.
		require.Equal(t, http.StatusNotFound, rr.Code)
		assert.NotContains(t, rr.Body.String(), `"gateways"`,
			"the registry must not be reachable under the tunnel's prefix")
		assert.Empty(t, sawID)
	})

	t.Run("the constants stay under their own parents", func(t *testing.T) {
		// Spelled out rather than recomposed: recomposition is exactly the bug.
		assert.Equal(t, "/api/openshell", OpenShellPathPrefix)
		assert.Equal(t, "/api/v1/openshell/gateways", OpenShellGatewaysPath)
		assert.NotContains(t, OpenShellGatewaysPath, OpenShellPathPrefix+"/",
			"the registry must not sit inside the tunnel's subtree")
	})
}

// Moving the registry under /api/v1 puts it behind InjectRequestIdentity, which
// gates on that prefix. That is the intended split and is pinned here: the
// registry now needs a caller identity, while the tunnel — whose credentials are
// the gateway's, not RHOAI's, and are swapped in swapToOpenShellToken — does not.
func TestOpenShellRegistryIsIdentityGatedButTheTunnelIsNot(t *testing.T) {
	var sawID, sawRest string
	routes := newRoutedTestApp(t, config.EnvConfig{
		AuthMethod:      config.AuthMethodUser,
		AuthTokenHeader: "Authorization",
		AuthTokenPrefix: "Bearer ",
	}, openShellTestFleet(t, &sawID, &sawRest, nil))

	t.Run("registry without an identity is refused", func(t *testing.T) {
		rr := httptest.NewRecorder()
		routes.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, OpenShellGatewaysPath, nil))
		assert.Equal(t, http.StatusUnauthorized, rr.Code)
	})

	t.Run("registry with an identity is served", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, OpenShellGatewaysPath, nil)
		req.Header.Set("Authorization", "Bearer some-openshift-token")
		rr := httptest.NewRecorder()
		routes.ServeHTTP(rr, req)
		require.Equal(t, http.StatusOK, rr.Code, "body: %s", rr.Body.String())
		assert.Contains(t, rr.Body.String(), `"gateways"`)
	})

	t.Run("the tunnel is not gated on a RHOAI identity", func(t *testing.T) {
		sawID, sawRest = "", ""
		rr := httptest.NewRecorder()
		routes.ServeHTTP(rr, httptest.NewRequest(http.MethodGet,
			OpenShellPathPrefix+"/prod/api/v1/workspaces", nil))
		require.Equal(t, teapot, rr.Code, "body: %s", rr.Body.String())
		assert.Equal(t, "prod", sawID)
	})
}

// The trust boundary, asserted where it actually has to hold: on a request that
// has travelled the real mux into the real fleet router.
//
// A leak already shipped from this exact seam once. It survived because the
// tests called swapToOpenShellToken directly, so nothing noticed that one
// dispatch path never invoked it. Testing the helper proves the helper works; it
// cannot prove the helper is wired in. This drives app.Routes() so the assertion
// covers the wiring — delete `Rewrite: swapToOpenShellToken` from newRouter and
// this test is what fails.
func TestPlatformCredentialsNeverReachAGateway(t *testing.T) {
	const (
		platformToken  = "TOKEN-A-openshift-replayable-against-the-cluster"
		openShellToken = "TOKEN-B-scoped-to-this-gateway"
	)

	var sawID, sawRest string
	var sawHeader http.Header
	routes := newRoutedTestApp(t,
		config.EnvConfig{AuthMethod: config.AuthMethodDisabled},
		openShellTestFleet(t, &sawID, &sawRest, &sawHeader))

	req := httptest.NewRequest(http.MethodGet, OpenShellPathPrefix+"/prod/api/v1/workspaces", nil)
	// Everything the two RHOAI hops in front of this BFF can put on a request.
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
	// which is how X-Auth-Request-Access-Token survived the first version of the
	// swap. Any header carrying the platform token fails this, named or not.
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
