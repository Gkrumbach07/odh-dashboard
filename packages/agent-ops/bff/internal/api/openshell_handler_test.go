package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opendatahub-io/mod-arch-library/bff/internal/config"
	"github.com/opendatahub-io/mod-arch-library/bff/pkg/fleet"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestApp(cfg config.EnvConfig) *App {
	return &App{config: cfg, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func TestParseGateways(t *testing.T) {
	t.Run("empty disables the feature", func(t *testing.T) {
		got, err := ParseGateways("")
		require.NoError(t, err)
		assert.Empty(t, got)
	})

	t.Run("parses a gateway and defaults the name to the id", func(t *testing.T) {
		got, err := ParseGateways(`[{"id":"prod","gatewayUrl":"openshell.openshell.svc:8080",
			"issuer":"https://idp","clientId":"openshell-dashboard","audience":"openshell-dashboard"}]`)
		require.NoError(t, err)
		require.Len(t, got, 1)
		assert.Equal(t, "prod", got[0].ID)
		assert.Equal(t, "prod", got[0].Name)
		assert.Equal(t, "openshell.openshell.svc:8080", got[0].GatewayURL)
		assert.Equal(t, "https://idp", got[0].Issuer)
	})

	t.Run("requires a gateway endpoint", func(t *testing.T) {
		_, err := ParseGateways(`[{"id":"prod"}]`)
		assert.ErrorContains(t, err, "no gatewayUrl")
	})

	t.Run("rejects ids that are not path-safe, and duplicates", func(t *testing.T) {
		for _, bad := range []string{"../etc", "Prod", "has space", "", "a/b"} {
			_, err := ParseGateways(`[{"id":"` + bad + `","gatewayUrl":"host:8080"}]`)
			assert.Error(t, err, "id %q should be rejected", bad)
		}
		_, err := ParseGateways(`[{"id":"a","gatewayUrl":"h:1"},{"id":"a","gatewayUrl":"h:2"}]`)
		assert.ErrorContains(t, err, "duplicate")

		_, err = ParseGateways(`not json`)
		assert.ErrorContains(t, err, "valid JSON array")
	})
}

// The trust boundary. Embedding makes this MORE important, not less: the App's
// auth middleware falls back to Authorization when its token header is absent,
// so a surviving RHOAI token would be forwarded straight to the gateway.
func TestSwapToOpenShellToken(t *testing.T) {
	t.Run("destroys RHOAI credentials and projects the OpenShell token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/workspaces", nil)
		req.Header.Set("Authorization", "Bearer TOKEN-A-openshift")
		req.Header.Set("X-Forwarded-Access-Token", "TOKEN-A-openshift")
		req.Header.Set("X-Auth-Request-User", "someone")
		req.Header.Set("X-Auth-Request-Groups", "admins")
		req.Header.Set("Cookie", "_oauth_proxy=rhoai-session")
		req.Header.Set(OpenShellAuthHeader, "Bearer TOKEN-B-openshell")

		swapToOpenShellToken(req, fleet.Backend{ID: "prod"})

		// No trace of the RHOAI token may remain anywhere.
		for name, v := range req.Header {
			for _, val := range v {
				assert.NotContains(t, val, "TOKEN-A-openshift", "header %s still carries the RHOAI token", name)
			}
		}
		assert.Empty(t, req.Header.Get("Cookie"), "the RHOAI session cookie must not survive")
		assert.Empty(t, req.Header.Get("X-Auth-Request-User"))
		assert.Empty(t, req.Header.Get("X-Auth-Request-Groups"))

		// The OpenShell token reaches the App on both headers it might read.
		assert.Equal(t, "Bearer TOKEN-B-openshell", req.Header.Get("Authorization"))
		assert.Equal(t, "TOKEN-B-openshell", req.Header.Get("X-Forwarded-Access-Token"))
		// The carrier header is consumed, not passed on.
		assert.Empty(t, req.Header.Get(OpenShellAuthHeader))
	})

	t.Run("strips the RHOAI token even when no OpenShell token is supplied", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/workspaces", nil)
		req.Header.Set("X-Forwarded-Access-Token", "TOKEN-A-openshift")
		req.Header.Set("Authorization", "Bearer TOKEN-A-openshift")
		req.Header.Set("Cookie", "_oauth_proxy=rhoai-session")

		swapToOpenShellToken(req, fleet.Backend{ID: "prod"})

		assert.Empty(t, req.Header.Get("X-Forwarded-Access-Token"))
		assert.Empty(t, req.Header.Get("Authorization"))
		assert.Empty(t, req.Header.Get("Cookie"))
	})

	t.Run("never falls back to Authorization", func(t *testing.T) {
		// RHOAI's fronting gateway rewrites Authorization to the platform's own
		// OpenShift token. Treating it as an OpenShell token would forward the
		// wrong credential to the gateway, so this must fail closed.
		req := httptest.NewRequest(http.MethodGet, "/api/v1/workspaces", nil)
		req.Header.Set("Authorization", "Bearer TOKEN-A-openshift")

		swapToOpenShellToken(req, fleet.Backend{ID: "prod"})

		assert.Empty(t, req.Header.Get("Authorization"))
		assert.Empty(t, req.Header.Get("X-Forwarded-Access-Token"))
	})
}

// Sign-in and no-access must stay distinguishable: prompting a login on a 403
// loops the user through their IdP back to the same refusal.
func TestMapRefusals(t *testing.T) {
	cases := []struct {
		status   int
		wantCode string
	}{
		{http.StatusUnauthorized, "gateway_auth_required"},
		{http.StatusForbidden, "gateway_forbidden"},
	}
	for _, c := range cases {
		inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(c.status)
			_, _ = w.Write([]byte(`{"code":"upstream","message":"gateway internal detail"}`))
		})

		rr := httptest.NewRecorder()
		mapRefusals(inner, "Production").ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/x", nil))

		require.Equal(t, c.status, rr.Code)
		var body map[string]string
		require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
		assert.Equal(t, c.wantCode, body["code"])
		assert.Contains(t, body["message"], "Production")
		// Gateway-internal detail is not relayed to the browser.
		assert.NotContains(t, rr.Body.String(), "gateway internal detail")
	}

	t.Run("leaves successful responses alone", func(t *testing.T) {
		inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"workspaces":[]}`))
		})
		rr := httptest.NewRecorder()
		mapRefusals(inner, "Production").ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/x", nil))

		require.Equal(t, http.StatusOK, rr.Code)
		assert.JSONEq(t, `{"workspaces":[]}`, rr.Body.String())
	})
}

func TestEmbeddedFeatureSurface(t *testing.T) {
	// Terminal needs a WebSocket, which the embedding cannot carry. Masking here
	// means a gateway admin is never asked to disable it in their own console.
	assert.False(t, embeddedFeatureFlags().Terminal)
	assert.True(t, embeddedFeatureFlags().FileTransfer)

	assert.False(t, maskFeatures(nil)["terminal"])
	assert.True(t, maskFeatures(nil)["fileTransfer"])
}

func TestOpenShellRoutesDisabledWithoutGateways(t *testing.T) {
	app := newTestApp(config.EnvConfig{})

	rr := httptest.NewRecorder()
	app.OpenShellProxyHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/openshell/x/y", nil))
	require.Equal(t, http.StatusServiceUnavailable, rr.Code)
	var body map[string]string
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
	assert.Equal(t, "openshell_disabled", body["code"])

	rr = httptest.NewRecorder()
	app.OpenShellGatewaysHandler(rr, httptest.NewRequest(http.MethodGet, OpenShellGatewaysPath, nil), nil)
	require.Equal(t, http.StatusOK, rr.Code)
	var list struct {
		Gateways []GatewayView `json:"gateways"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &list))
	assert.Empty(t, list.Gateways)
}

// SplitPath is generic; this pins the OpenShell prefix behaviour the routes rely
// on. The prefix is multi-segment ("/api/openshell"), which SplitPath handles
// because it trims the prefix literally rather than segment by segment.
func TestSplitGatewayPath(t *testing.T) {
	for _, c := range []struct{ in, wantID, wantRest string }{
		{"/api/openshell/prod/api/v1/workspaces", "prod", "/api/v1/workspaces"},
		{"/api/openshell/prod/", "prod", "/"},
		{"/api/openshell/prod", "prod", "/"},
		{"/api/openshell/", "", "/"},
	} {
		id, rest := fleet.SplitPath(OpenShellPathPrefix, c.in)
		assert.Equal(t, c.wantID, id, "id for %q", c.in)
		assert.Equal(t, c.wantRest, rest, "rest for %q", c.in)
	}
}
