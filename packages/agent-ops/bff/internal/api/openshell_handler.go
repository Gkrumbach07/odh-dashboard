package api

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/opendatahub-io/mod-arch-library/bff/pkg/fleet"
)

// OpenShell is a separate service with its own identity domain. The RHOAI token
// authenticates the user to RHOAI and stops here; to reach a gateway the browser
// signs in to THAT gateway's OIDC provider and sends the resulting token on a
// dedicated header.
//
// Routing, discovery and readiness are generic and live in pkg/fleet. This file is
// the OpenShell-specific policy layered on top: which credential crosses the
// boundary, and how a refusal is reported back.
const (
	OpenShellPathPrefix   = "/openshell"
	OpenShellGatewaysPath = OpenShellPathPrefix + "/gateways"

	// OpenShellAuthHeader is the dedicated header the browser uses to carry the
	// OpenShell token. RHOAI's data-science-gateway ext-authz rewrites
	// Authorization and x-forwarded-access-token to the platform's OWN OpenShift
	// token, so the OpenShell token must ride a header the gateway leaves
	// untouched. Must match OPENSHELL_AUTH_HEADER in the frontend.
	OpenShellAuthHeader = "X-OpenShell-Authorization"
)

// OpenShellGatewaysHandler lists the configured installs with their discovery
// state. Public to an authenticated RHOAI user: it returns only non-secret client
// metadata, never a token.
func (app *App) OpenShellGatewaysHandler(w http.ResponseWriter, r *http.Request) {
	views := []GatewayView{}
	if app.openShell != nil && app.openShell.Len() > 0 {
		for _, e := range app.openShell.Entries(r.Context()) {
			views = append(views, viewOf(e))
		}
	}
	writeOpenShellJSON(w, http.StatusOK, map[string]any{"gateways": views})
}

// OpenShellProxyHandler routes /openshell/{gatewayId}/... to that install's relay BFF.
func (app *App) OpenShellProxyHandler() http.Handler {
	if app.openShell == nil || app.openShell.Len() == 0 {
		app.logger.Info("no OpenShell gateways configured; OpenShell routes disabled")
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeOpenShellError(w, http.StatusServiceUnavailable, "openshell_disabled",
				"No OpenShell gateways are configured for this deployment")
		})
	}

	return &fleet.Router{
		Prefix:    OpenShellPathPrefix,
		Backends:  app.openShell,
		Readiness: app.openShell,
		Logger:    app.logger,
		// Federated mode is HTTP request/response only: a browser cannot put a
		// bearer on a protocol upgrade, so an upgrade is refused here rather than
		// forwarded without credentials.
		RejectUpgrades: true,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				RootCAs:            app.rootCAs,
				InsecureSkipVerify: app.config.InsecureSkipVerify, //nolint:gosec // config-gated (INSECURE_SKIP_VERIFY), dev/POC only
			},
		},
		Codes: fleet.Codes{
			MissingID:          "gateway_missing",
			UnknownID:          "gateway_unknown",
			NotReady:           "gateway_not_ready",
			Unreachable:        "gateway_unreachable",
			UpgradeUnsupported: "upgrade_unsupported",
			NotConfigured:      "openshell_disabled",
		},
		WriteError: writeOpenShellError,
		Rewrite:    swapToOpenShellToken,
		OnResponse: mapOpenShellRefusal,
	}
}

// swapToOpenShellToken is the trust boundary.
//
// The RHOAI credentials must NOT cross into OpenShell. The fronting gateway
// (kube-auth-proxy) OWNS `Authorization` and `x-forwarded-access-token`, rewriting
// both to the platform's OpenShift access token — a credential that could be
// replayed against the cluster API as the user. So the OpenShell token arrives on a
// dedicated header the gateway passes through untouched, and every RHOAI credential
// is destroyed here regardless of what follows.
func swapToOpenShellToken(req *http.Request, _ fleet.Backend) {
	token := strings.TrimSpace(strings.TrimPrefix(req.Header.Get(OpenShellAuthHeader), "Bearer "))
	if token == "" {
		// Standalone/dev fallback: no fronting gateway rewriting Authorization.
		token = strings.TrimSpace(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "))
	}

	req.Header.Del(OpenShellAuthHeader)
	req.Header.Del("X-Forwarded-Access-Token")
	req.Header.Del("Authorization")
	req.Header.Del("X-Auth-Request-User")
	req.Header.Del("X-Auth-Request-Groups")
	req.Header.Del("X-Auth-Request-Email")
	req.Header.Del("X-Auth-Request-Preferred-Username")
	req.Header.Del("Cookie")

	if token != "" {
		// Project onto both so no RHOAI token value can leak downstream regardless
		// of the relay's precedence chain.
		req.Header.Set("X-Forwarded-Access-Token", token)
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

// mapOpenShellRefusal keeps "sign in" and "you have no access" distinguishable.
// Collapsing them sends a user through their IdP only to meet the same refusal.
func mapOpenShellRefusal(resp *http.Response, b fleet.Backend) error {
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return rewriteOpenShellBody(resp, "gateway_auth_required",
			fmt.Sprintf("Sign in to the %s gateway to continue", b.Name))
	case http.StatusForbidden:
		return rewriteOpenShellBody(resp, "gateway_forbidden",
			fmt.Sprintf("Your account has no access to the %s gateway", b.Name))
	default:
		return nil
	}
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
