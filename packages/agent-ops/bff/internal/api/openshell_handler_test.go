package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opendatahub-io/mod-arch-library/bff/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestApp(cfg config.EnvConfig) *App {
	return &App{config: cfg, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

// newTestAppWithGateways wires a registry over the given installs.
func newTestAppWithGateways(t *testing.T, gateways ...Gateway) *App {
	t.Helper()
	app := newTestApp(config.EnvConfig{})
	app.openShell = NewGatewayRegistry(gateways, nil, false, app.logger)
	return app
}

func TestParseGateways(t *testing.T) {
	t.Run("empty disables the feature", func(t *testing.T) {
		got, err := ParseGateways("")
		require.NoError(t, err)
		assert.Empty(t, got)
	})

	t.Run("parses and defaults the name to the id", func(t *testing.T) {
		got, err := ParseGateways(`[{"id":"prod","bffUrl":"https://openshell.svc:8443/"}]`)
		require.NoError(t, err)
		require.Len(t, got, 1)
		assert.Equal(t, "prod", got[0].ID)
		assert.Equal(t, "prod", got[0].Name)
		// Trailing slash trimmed so path joins do not double up.
		assert.Equal(t, "https://openshell.svc:8443", got[0].BFFURL)
	})

	t.Run("rejects ids that are not path-safe", func(t *testing.T) {
		for _, bad := range []string{"../etc", "Prod", "has space", "", "a/b"} {
			_, err := ParseGateways(`[{"id":"` + bad + `","bffUrl":"https://x"}]`)
			assert.Error(t, err, "id %q should be rejected", bad)
		}
	})

	t.Run("rejects duplicates and bad targets", func(t *testing.T) {
		_, err := ParseGateways(`[{"id":"a","bffUrl":"https://x"},{"id":"a","bffUrl":"https://y"}]`)
		assert.ErrorContains(t, err, "duplicate")

		_, err = ParseGateways(`[{"id":"a"}]`)
		assert.ErrorContains(t, err, "no bffUrl")

		_, err = ParseGateways(`[{"id":"a","bffUrl":"ftp://x"}]`)
		assert.ErrorContains(t, err, "must be http")

		_, err = ParseGateways(`not json`)
		assert.ErrorContains(t, err, "valid JSON array")
	})
}

func TestSplitGatewayPath(t *testing.T) {
	cases := []struct{ in, wantID, wantRest string }{
		{"/openshell/prod/api/v1/workspaces", "prod", "/api/v1/workspaces"},
		{"/openshell/prod/", "prod", "/"},
		{"/openshell/prod", "prod", "/"},
		{"/openshell/", "", "/"},
	}
	for _, c := range cases {
		id, rest := splitGatewayPath(c.in)
		assert.Equal(t, c.wantID, id, "id for %q", c.in)
		assert.Equal(t, c.wantRest, rest, "rest for %q", c.in)
	}
}

func TestMaskFeatures(t *testing.T) {
	// Terminal needs a WebSocket, which the embedding cannot carry — masked off even
	// though the gateway legitimately offers it on its own console.
	got := maskFeatures(map[string]bool{"terminal": true, "fileTransfer": true})
	assert.False(t, got["terminal"])
	assert.True(t, got["fileTransfer"])

	// A gateway that never mentioned the feature does not gain a false key.
	got = maskFeatures(map[string]bool{"fileTransfer": true})
	_, present := got["terminal"]
	assert.False(t, present)
}

func TestOpenShellGatewaysHandler(t *testing.T) {
	t.Run("returns an empty list when nothing is configured", func(t *testing.T) {
		app := newTestApp(config.EnvConfig{})
		rr := httptest.NewRecorder()
		app.OpenShellGatewaysHandler(rr, httptest.NewRequest(http.MethodGet, OpenShellGatewaysPath, nil))

		require.Equal(t, http.StatusOK, rr.Code)
		var got struct {
			Gateways []GatewayView `json:"gateways"`
		}
		require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
		assert.Empty(t, got.Gateways)
	})

	t.Run("reports discovered identity metadata", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "/api/v1/auth/config", r.URL.Path)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"issuer":     "https://idp.example/realms/openshell",
				"clientId":   "openshell-dashboard",
				"audience":   "openshell-gateway",
				"apiVersion": "0.1.3",
				"features":   map[string]bool{"terminal": true, "fileTransfer": true},
			})
		}))
		defer upstream.Close()

		app := newTestAppWithGateways(t, Gateway{ID: "prod", Name: "Production", BFFURL: upstream.URL})
		rr := httptest.NewRecorder()
		app.OpenShellGatewaysHandler(rr, httptest.NewRequest(http.MethodGet, OpenShellGatewaysPath, nil))

		require.Equal(t, http.StatusOK, rr.Code)
		var got struct {
			Gateways []GatewayView `json:"gateways"`
		}
		require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
		require.Len(t, got.Gateways, 1)

		view := got.Gateways[0]
		assert.True(t, view.Connectable)
		assert.Equal(t, "https://idp.example/realms/openshell", view.Issuer)
		assert.Equal(t, "openshell-dashboard", view.ClientID)
		assert.Equal(t, "openshell-gateway", view.Audience)
		// Masked for the embedded surface.
		assert.False(t, view.Features["terminal"])
		assert.True(t, view.Features["fileTransfer"])
	})

	t.Run("marks a gateway unconnectable when discovery fails", func(t *testing.T) {
		app := newTestAppWithGateways(t, Gateway{ID: "down", BFFURL: "https://127.0.0.1:1"})
		rr := httptest.NewRecorder()
		app.OpenShellGatewaysHandler(rr, httptest.NewRequest(http.MethodGet, OpenShellGatewaysPath, nil))

		var got struct {
			Gateways []GatewayView `json:"gateways"`
		}
		require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
		require.Len(t, got.Gateways, 1)
		assert.False(t, got.Gateways[0].Connectable)
		assert.NotEmpty(t, got.Gateways[0].Error)
	})

	t.Run("a gateway with auth disabled is connectable without an issuer", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"authDisabled": true})
		}))
		defer upstream.Close()

		app := newTestAppWithGateways(t, Gateway{ID: "dev", BFFURL: upstream.URL})
		view := app.openShell.View(t.Context(), "dev")
		assert.True(t, view.Connectable)
		assert.True(t, view.AuthDisabled)
	})
}

func TestOpenShellProxyTrustBoundary(t *testing.T) {
	type captured struct {
		auth        string
		forwarded   string
		openShell   string
		cookie      string
		authUser    string
		path        string
		requestSeen bool
	}

	newUpstream := func(got *captured, status int) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got.requestSeen = true
			got.path = r.URL.Path
			got.auth = r.Header.Get("Authorization")
			got.forwarded = r.Header.Get("X-Forwarded-Access-Token")
			got.openShell = r.Header.Get(OpenShellAuthHeader)
			got.cookie = r.Header.Get("Cookie")
			got.authUser = r.Header.Get("X-Auth-Request-User")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"code":"upstream","message":"gateway internal detail"}`))
		}))
	}

	t.Run("destroys RHOAI credentials and projects Token B", func(t *testing.T) {
		var got captured
		upstream := newUpstream(&got, http.StatusOK)
		defer upstream.Close()

		app := newTestAppWithGateways(t, Gateway{ID: "prod", Name: "Production", BFFURL: upstream.URL})

		req := httptest.NewRequest(http.MethodGet, "/openshell/prod/api/v1/workspaces", nil)
		req.Header.Set("Authorization", "Bearer TOKEN-A-openshift")
		req.Header.Set("X-Forwarded-Access-Token", "TOKEN-A-openshift")
		req.Header.Set("X-Auth-Request-User", "someone")
		req.Header.Set("Cookie", "_oauth_proxy=rhoai-session")
		req.Header.Set(OpenShellAuthHeader, "Bearer TOKEN-B-openshell")

		rr := httptest.NewRecorder()
		app.OpenShellProxyHandler().ServeHTTP(rr, req)

		require.True(t, got.requestSeen, "upstream should have been reached")
		assert.Equal(t, "/api/v1/workspaces", got.path, "gateway id is stripped from the path")

		// Token A must not exist downstream in any form.
		assert.NotContains(t, got.auth, "TOKEN-A-openshift")
		assert.NotContains(t, got.forwarded, "TOKEN-A-openshift")
		assert.Empty(t, got.cookie, "the RHOAI session cookie must not cross the boundary")
		assert.Empty(t, got.authUser)

		// Token B is projected onto both headers the relay might read.
		assert.Equal(t, "Bearer TOKEN-B-openshell", got.auth)
		assert.Equal(t, "TOKEN-B-openshell", got.forwarded)
		// The carrier header itself is consumed, not forwarded.
		assert.Empty(t, got.openShell)
	})

	t.Run("strips Token A even when no Token B is supplied", func(t *testing.T) {
		var got captured
		upstream := newUpstream(&got, http.StatusOK)
		defer upstream.Close()

		app := newTestAppWithGateways(t, Gateway{ID: "prod", BFFURL: upstream.URL})

		req := httptest.NewRequest(http.MethodGet, "/openshell/prod/api/v1/workspaces", nil)
		req.Header.Set("X-Forwarded-Access-Token", "TOKEN-A-openshift")
		req.Header.Set("Cookie", "_oauth_proxy=rhoai-session")

		rr := httptest.NewRecorder()
		app.OpenShellProxyHandler().ServeHTTP(rr, req)

		require.True(t, got.requestSeen)
		assert.Empty(t, got.forwarded)
		assert.Empty(t, got.auth)
		assert.Empty(t, got.cookie)
	})

	t.Run("distinguishes needing a sign-in from being refused", func(t *testing.T) {
		for status, wantCode := range map[int]string{
			http.StatusUnauthorized: "gateway_auth_required",
			http.StatusForbidden:    "gateway_forbidden",
		} {
			var got captured
			upstream := newUpstream(&got, status)

			app := newTestAppWithGateways(t, Gateway{ID: "prod", Name: "Production", BFFURL: upstream.URL})
			req := httptest.NewRequest(http.MethodGet, "/openshell/prod/api/v1/workspaces", nil)
			rr := httptest.NewRecorder()
			app.OpenShellProxyHandler().ServeHTTP(rr, req)

			require.Equal(t, status, rr.Code)
			var body map[string]string
			require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
			assert.Equal(t, wantCode, body["code"])
			// Gateway-internal detail is not relayed to the browser.
			assert.NotContains(t, rr.Body.String(), "gateway internal detail")

			upstream.Close()
		}
	})

	t.Run("refuses protocol upgrades", func(t *testing.T) {
		app := newTestAppWithGateways(t, Gateway{ID: "prod", BFFURL: "https://unused"})
		req := httptest.NewRequest(http.MethodGet, "/openshell/prod/api/v1/x/terminal", nil)
		req.Header.Set("Upgrade", "websocket")
		req.Header.Set("Connection", "Upgrade")

		rr := httptest.NewRecorder()
		app.OpenShellProxyHandler().ServeHTTP(rr, req)

		require.Equal(t, http.StatusNotImplemented, rr.Code)
		var body map[string]string
		require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
		assert.Equal(t, "upgrade_unsupported", body["code"])
	})

	t.Run("rejects unknown and missing gateway ids", func(t *testing.T) {
		app := newTestAppWithGateways(t, Gateway{ID: "prod", BFFURL: "https://unused"})

		for path, wantCode := range map[string]string{
			"/openshell/nope/api/v1/x": "gateway_unknown",
			"/openshell/":              "gateway_missing",
		} {
			rr := httptest.NewRecorder()
			app.OpenShellProxyHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
			require.Equal(t, http.StatusNotFound, rr.Code, "path %s", path)
			var body map[string]string
			require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
			assert.Equal(t, wantCode, body["code"], "path %s", path)
		}
	})

	t.Run("reports a disabled feature when no gateways are configured", func(t *testing.T) {
		app := newTestApp(config.EnvConfig{})
		rr := httptest.NewRecorder()
		app.OpenShellProxyHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/openshell/x/y", nil))

		require.Equal(t, http.StatusServiceUnavailable, rr.Code)
		var body map[string]string
		require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
		assert.Equal(t, "openshell_disabled", body["code"])
	})
}
