package api

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"

	helper "github.com/opendatahub-io/mod-arch-library/bff/internal/helpers"
)

// OpenShell is a separate service with its own identity domain. The RHOAI token
// (Token A) authenticates the user to RHOAI and stops here; to reach a gateway the
// browser signs in to THAT gateway's OIDC provider and sends the resulting token
// (Token B) on a dedicated header.
//
// This file is the trust boundary and the router:
//
//   - GET /openshell/gateways      — the registry: which installs exist, and what
//     each one says about its own identity domain.
//   - /openshell/{gatewayId}/...   — reverse-proxies to that install's relay BFF,
//     forwarding ONLY Token B and destroying every RHOAI credential on the way past.
//
// It is deliberately stateless: no sessions, no token storage, no protocol upgrades.
const (
	OpenShellPathPrefix   = "/openshell"
	OpenShellGatewaysPath = OpenShellPathPrefix + "/gateways"

	// OpenShellAuthHeader is the dedicated header the browser uses to carry Token B.
	// RHOAI's data-science-gateway ext-authz rewrites Authorization and
	// x-forwarded-access-token to the platform's OWN OpenShift token, so Token B must
	// ride a header the gateway leaves untouched. Must match OPENSHELL_AUTH_HEADER
	// in the frontend (openShellAuth.ts).
	OpenShellAuthHeader = "X-OpenShell-Authorization"
)

// openShellRouter dispatches /openshell/{gatewayId}/... to the right install and
// caches one reverse proxy per gateway.
type openShellRouter struct {
	app     *App
	proxies map[string]*httputil.ReverseProxy
	mu      sync.Mutex
}

// OpenShellGatewaysHandler lists the configured installs with their discovery state.
// Public to an authenticated RHOAI user: it returns only non-secret client metadata,
// never a token.
func (app *App) OpenShellGatewaysHandler(w http.ResponseWriter, r *http.Request) {
	if app.openShell == nil || app.openShell.Len() == 0 {
		writeOpenShellJSON(w, http.StatusOK, map[string]any{"gateways": []GatewayView{}})
		return
	}
	views := app.openShell.Views(r.Context())
	writeOpenShellJSON(w, http.StatusOK, map[string]any{"gateways": views})
}

// OpenShellProxyHandler routes /openshell/{gatewayId}/... to that gateway's relay BFF.
func (app *App) OpenShellProxyHandler() http.Handler {
	if app.openShell == nil || app.openShell.Len() == 0 {
		app.logger.Info("no OpenShell gateways configured; OpenShell routes disabled")
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeOpenShellError(w, http.StatusServiceUnavailable, "openshell_disabled",
				"No OpenShell gateways are configured for this deployment")
		})
	}
	return &openShellRouter{app: app, proxies: map[string]*httputil.ReverseProxy{}}
}

func (router *openShellRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Federated mode is HTTP request/response only. A browser cannot put a bearer on
	// a protocol upgrade, so upgrades are refused here rather than forwarded without
	// credentials — the gateway's own console keeps its terminal.
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		writeOpenShellError(w, http.StatusNotImplemented, "upgrade_unsupported",
			"WebSocket is not available in the embedded dashboard; open the OpenShell console for a terminal")
		return
	}

	gatewayID, rest := splitGatewayPath(r.URL.Path)
	if gatewayID == "" {
		writeOpenShellError(w, http.StatusNotFound, "gateway_missing",
			"Request path must name a gateway: /openshell/{gatewayId}/...")
		return
	}

	gateway, ok := router.app.openShell.Lookup(gatewayID)
	if !ok {
		writeOpenShellError(w, http.StatusNotFound, "gateway_unknown",
			fmt.Sprintf("No OpenShell gateway named %q is configured", gatewayID))
		return
	}

	proxy, err := router.proxyFor(gateway)
	if err != nil {
		router.app.logger.Error("building OpenShell proxy failed",
			slog.String("gateway", gateway.ID), slog.Any("error", err))
		writeOpenShellError(w, http.StatusInternalServerError, "gateway_misconfigured",
			fmt.Sprintf("Gateway %q is misconfigured", gateway.ID))
		return
	}

	// Hand the proxy the downstream path; the Director rewrites scheme and host.
	outbound := r.Clone(r.Context())
	outbound.URL.Path = rest
	proxy.ServeHTTP(w, outbound)
}

func (router *openShellRouter) proxyFor(gateway Gateway) (*httputil.ReverseProxy, error) {
	router.mu.Lock()
	defer router.mu.Unlock()

	if proxy, ok := router.proxies[gateway.ID]; ok {
		return proxy, nil
	}

	targetURL, err := url.Parse(gateway.BFFURL)
	if err != nil {
		return nil, fmt.Errorf("invalid bffUrl %q: %w", gateway.BFFURL, err)
	}

	app := router.app
	proxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Honour the app's trusted CA pool for the outbound leg (serving-cert on-cluster).
	proxy.Transport = &http.Transport{
		TLSClientConfig: &tls.Config{
			RootCAs:            app.rootCAs,
			InsecureSkipVerify: app.config.InsecureSkipVerify, //nolint:gosec // config-gated (INSECURE_SKIP_VERIFY), dev/POC only
		},
	}

	origDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		origDirector(req)
		req.Host = targetURL.Host

		// ── TRUST BOUNDARY ───────────────────────────────────────────────
		// The RHOAI credentials must NOT cross into OpenShell. The fronting gateway
		// (kube-auth-proxy) OWNS `Authorization` and `x-forwarded-access-token`,
		// rewriting both to the platform's OpenShift access token — a credential
		// that could be replayed against the cluster API as the user. So Token B
		// arrives on a dedicated header the gateway passes through untouched, and
		// every RHOAI credential is destroyed here regardless of what follows.
		tokenB := strings.TrimSpace(strings.TrimPrefix(req.Header.Get(OpenShellAuthHeader), "Bearer "))
		if tokenB == "" {
			// Standalone/dev fallback: no fronting gateway rewriting Authorization.
			tokenB = strings.TrimSpace(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "))
		}

		req.Header.Del(OpenShellAuthHeader)
		req.Header.Del("X-Forwarded-Access-Token")
		req.Header.Del("Authorization")
		req.Header.Del("X-Auth-Request-User")
		req.Header.Del("X-Auth-Request-Groups")
		req.Header.Del("X-Auth-Request-Email")
		req.Header.Del("X-Auth-Request-Preferred-Username")
		req.Header.Del("Cookie")

		if tokenB != "" {
			// Project onto both so no Token A value can leak downstream regardless
			// of the relay's precedence chain.
			req.Header.Set("X-Forwarded-Access-Token", tokenB)
			req.Header.Set("Authorization", "Bearer "+tokenB)
		}
	}

	// The browser must be able to tell "I need to sign in to this gateway" from
	// "I am signed in and not allowed". Collapsing them sends a user through their
	// IdP only to meet the same refusal.
	proxy.ModifyResponse = func(resp *http.Response) error {
		switch resp.StatusCode {
		case http.StatusUnauthorized:
			return rewriteOpenShellBody(resp, "gateway_auth_required",
				fmt.Sprintf("Sign in to the %s gateway to continue", gateway.Name))
		case http.StatusForbidden:
			return rewriteOpenShellBody(resp, "gateway_forbidden",
				fmt.Sprintf("Your account has no access to the %s gateway", gateway.Name))
		default:
			return nil
		}
	}

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, perr error) {
		helper.GetContextLoggerFromReq(r).Error("OpenShell reverse proxy error",
			slog.Any("error", perr),
			slog.String("gateway", gateway.ID),
			slog.String("path", r.URL.Path))
		writeOpenShellError(w, http.StatusBadGateway, "gateway_unreachable",
			fmt.Sprintf("OpenShell gateway %q is unavailable", gateway.Name))
	}

	router.proxies[gateway.ID] = proxy
	return proxy, nil
}

// splitGatewayPath turns /openshell/{id}/rest into ("{id}", "/rest").
func splitGatewayPath(p string) (gatewayID, rest string) {
	trimmed := strings.TrimPrefix(p, OpenShellPathPrefix)
	trimmed = strings.TrimPrefix(trimmed, "/")
	if trimmed == "" {
		return "", "/"
	}
	id, remainder, found := strings.Cut(trimmed, "/")
	if !found || remainder == "" {
		return id, "/"
	}
	return id, "/" + remainder
}

// rewriteOpenShellBody replaces an upstream error body with the dashboard's coded
// envelope, so the frontend branches on a stable code rather than a bare status.
func rewriteOpenShellBody(resp *http.Response, code, message string) error {
	// The original body is not forwarded: it may carry gateway-internal detail.
	if resp.Body != nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		resp.Body.Close()
	}

	body, err := json.Marshal(map[string]string{"code": code, "message": message})
	if err != nil {
		return err
	}

	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Type", "application/json")
	resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	resp.Header.Del("Content-Encoding")
	return nil
}

func writeOpenShellJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeOpenShellError(w http.ResponseWriter, status int, code, message string) {
	writeOpenShellJSON(w, status, map[string]string{"code": code, "message": message})
}
