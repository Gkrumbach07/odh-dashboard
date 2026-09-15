package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/opendatahub-io/mod-arch-library/bff/pkg/fleet"
)

// OpenShell is a separate service with its own identity domain. The RHOAI token
// authenticates the user to RHOAI and stops at this boundary; to reach a gateway
// the browser signs in to THAT gateway's OIDC provider and sends the resulting
// token on a dedicated header.
//
// The upstream OpenShell BFF is embedded rather than proxied to, so a request is
// dispatched to an in-process App instead of forwarded over the network. What
// remains OpenShell-specific here is the credential swap and how a refusal is
// reported back.
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
// state. Returns only non-secret client metadata, never a token.
func (app *App) OpenShellGatewaysHandler(w http.ResponseWriter, r *http.Request) {
	views := []GatewayView{}
	if app.openShell != nil {
		views = app.openShell.Views(r.Context())
	}
	writeOpenShellJSON(w, http.StatusOK, map[string]any{"gateways": views})
}

// OpenShellProxyHandler routes /openshell/{gatewayId}/... to that install's
// embedded App.
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
		Handlers:  app.openShell.Handler,
		Logger:    app.logger,
		// Federated mode is HTTP request/response only: a browser cannot put a
		// bearer on a protocol upgrade, so an upgrade is refused here rather than
		// dispatched without credentials.
		RejectUpgrades: true,
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
	}
}

// swapToOpenShellToken is the trust boundary.
//
// The RHOAI credentials must NOT reach OpenShell. The fronting gateway
// (kube-auth-proxy) OWNS `Authorization` and `x-forwarded-access-token`, rewriting
// both to the platform's OpenShift access token — a credential that could be
// replayed against the cluster API as the user. So the OpenShell token arrives on
// a dedicated header the gateway passes through untouched, and every RHOAI
// credential is destroyed here regardless of what follows.
//
// This still matters when embedding: the App's auth middleware falls back to
// `Authorization` when its token header is absent, so leaving the RHOAI token in
// place would hand it straight to the gateway.
func swapToOpenShellToken(req *http.Request, _ fleet.Backend) {
	// ONLY the dedicated header is trusted. There is deliberately no fallback to
	// Authorization: RHOAI's fronting gateway rewrites that header to the
	// platform's OWN OpenShift token, so a request that merely omits the
	// OpenShell token would forward the RHOAI one to the OpenShell gateway
	// instead of failing closed. Absent the header, no token is forwarded and
	// the gateway answers 401, which the browser turns into a sign-in prompt.
	token := strings.TrimSpace(strings.TrimPrefix(req.Header.Get(OpenShellAuthHeader), "Bearer "))

	req.Header.Del(OpenShellAuthHeader)
	req.Header.Del("X-Forwarded-Access-Token")
	req.Header.Del("Authorization")
	req.Header.Del("X-Auth-Request-User")
	req.Header.Del("X-Auth-Request-Groups")
	req.Header.Del("X-Auth-Request-Email")
	req.Header.Del("X-Auth-Request-Preferred-Username")
	req.Header.Del("Cookie")

	if token != "" {
		// Project onto both so no RHOAI token value can reach the gateway
		// regardless of the App's precedence chain.
		req.Header.Set("X-Forwarded-Access-Token", token)
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

// mapRefusals keeps "sign in" and "you have no access" distinguishable. Collapsing
// them sends a user through their IdP only to meet the same refusal.
//
// The embedded App writes its response directly, so this intercepts the status as
// it is written rather than rewriting a proxied response.
func mapRefusals(next http.Handler, gatewayName string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&refusalWriter{ResponseWriter: w, gateway: gatewayName}, r)
	})
}

type refusalWriter struct {
	http.ResponseWriter
	gateway   string
	intercept bool
}

func (rw *refusalWriter) WriteHeader(status int) {
	var code, message string
	switch status {
	case http.StatusUnauthorized:
		code, message = "gateway_auth_required", fmt.Sprintf("Sign in to the %s gateway to continue", rw.gateway)
	case http.StatusForbidden:
		code, message = "gateway_forbidden", fmt.Sprintf("Your account has no access to the %s gateway", rw.gateway)
	default:
		rw.ResponseWriter.WriteHeader(status)
		return
	}

	body, err := json.Marshal(map[string]string{"code": code, "message": message})
	if err != nil {
		rw.ResponseWriter.WriteHeader(status)
		return
	}
	rw.intercept = true
	rw.Header().Set("Content-Type", "application/json")
	rw.Header().Set("Content-Length", strconv.Itoa(len(body)))
	rw.ResponseWriter.WriteHeader(status)
	_, _ = rw.ResponseWriter.Write(body)
}

// Write swallows the App's own body once a refusal has been rewritten, so
// gateway-internal detail is not relayed to the browser.
func (rw *refusalWriter) Write(b []byte) (int, error) {
	if rw.intercept {
		return len(b), nil
	}
	return rw.ResponseWriter.Write(b)
}

func writeOpenShellJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeOpenShellError(w http.ResponseWriter, status int, code, message string) {
	writeOpenShellJSON(w, status, map[string]string{"code": code, "message": message})
}
