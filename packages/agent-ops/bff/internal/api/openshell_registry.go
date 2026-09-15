package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/opendatahub-io/mod-arch-library/bff/pkg/fleet"
)

// OpenShell-specific half of the gateway fleet. Everything generic — the registry,
// discovery caching, readiness, backoff, and per-request routing — lives in
// pkg/fleet so a module that fronts several external gateways (MaaS, if its AI
// gateway becomes multi-tenant) can reuse it. What stays here is only what is true
// of OpenShell: the shape of its discovery document, which features the embedding
// cannot carry, and which credential its relay accepts.
//
// An OpenShell install is a gateway plus its own relay BFF, bound together by
// OPENSHELL_GATEWAY_URL on that BFF. Multi-gateway is therefore multi-install.

// Gateway is one OpenShell install.
type Gateway = fleet.Backend

// Discovery is the subset of a gateway BFF's public /api/v1/auth/config that the
// browser needs in order to obtain a token for that gateway. The dashboard never
// hardcodes an issuer: it asks each gateway who it trusts, which keeps the value
// that mints a token and the value that validates it from drifting apart.
type Discovery struct {
	Features     map[string]bool `json:"features,omitempty"`
	Issuer       string          `json:"issuer,omitempty"`
	ClientID     string          `json:"clientId,omitempty"`
	Audience     string          `json:"audience,omitempty"`
	Scope        string          `json:"scope,omitempty"`
	APIVersion   string          `json:"apiVersion,omitempty"`
	AuthDisabled bool            `json:"authDisabled,omitempty"`
}

// GatewayView is what the frontend receives for one gateway.
type GatewayView struct {
	Features   map[string]bool `json:"features"`
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	ConsoleURL string          `json:"consoleUrl,omitempty"`
	Issuer     string          `json:"issuer,omitempty"`
	ClientID   string          `json:"clientId,omitempty"`
	Audience   string          `json:"audience,omitempty"`
	Scope      string          `json:"scope,omitempty"`
	APIVersion string          `json:"apiVersion,omitempty"`
	// Error explains why Connectable is false, for the switcher to show inline.
	Error string `json:"error,omitempty"`
	// Connectable is true when discovery succeeded and the gateway advertised
	// enough for the browser to run its OIDC flow.
	Connectable bool `json:"connectable"`
	// AuthDisabled mirrors the gateway's dev-mode switch; no token is needed.
	AuthDisabled bool `json:"authDisabled,omitempty"`
}

// embeddedUnsupportedFeatures are capabilities a gateway may legitimately offer on
// its own standalone console but which the RHOAI embedding cannot carry. Terminal
// needs a WebSocket, and a browser cannot put a bearer on a protocol upgrade, so
// the embedded surface masks it off. The gateway's own console keeps it.
var embeddedUnsupportedFeatures = []string{"terminal"}

// ParseGateways reads the OPENSHELL_GATEWAYS JSON array.
func ParseGateways(raw string) ([]Gateway, error) {
	return fleet.ParseBackends(raw)
}

// NewGatewayRegistry builds the fleet over the configured installs. The HTTP client
// honours the app's trusted CA pool so in-cluster serving certs validate.
func NewGatewayRegistry(gateways []Gateway, rootCAs *x509.CertPool, insecure bool, logger *slog.Logger) *fleet.Registry[Discovery] {
	return fleet.New(gateways, discoverOpenShell, fleet.Options{
		Logger: logger,
		Client: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					RootCAs:            rootCAs,
					InsecureSkipVerify: insecure, //nolint:gosec // config-gated (INSECURE_SKIP_VERIFY), dev/POC only
				},
			},
		},
	})
}

// discoverOpenShell fetches /api/v1/auth/config from a gateway's relay BFF. That
// route is public and answers before any token exists, which is what makes it
// usable as discovery.
func discoverOpenShell(ctx context.Context, b fleet.Backend, client *http.Client) (Discovery, error) {
	var disco Discovery

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.URL+"/api/v1/auth/config", nil)
	if err != nil {
		return disco, fmt.Errorf("building discovery request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return disco, fmt.Errorf("gateway BFF unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return disco, fmt.Errorf("gateway BFF returned HTTP %d from /api/v1/auth/config", resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(&disco); err != nil {
		return disco, fmt.Errorf("gateway BFF returned an unreadable auth config: %w", err)
	}
	return disco, nil
}

// viewOf renders one fleet entry for the frontend.
func viewOf(e fleet.Entry[Discovery]) GatewayView {
	view := GatewayView{
		ID:         e.Backend.ID,
		Name:       e.Backend.Name,
		ConsoleURL: e.Backend.LinkURL,
		Error:      e.Err,
		Features:   map[string]bool{},
	}
	if !e.Ready {
		if view.Error == "" {
			view.Error = "gateway has not been reached yet"
		}
		return view
	}

	d := e.Discovery
	view.Issuer = d.Issuer
	view.ClientID = d.ClientID
	view.Audience = d.Audience
	view.Scope = d.Scope
	view.APIVersion = d.APIVersion
	view.AuthDisabled = d.AuthDisabled
	view.Features = maskFeatures(d.Features)
	// A gateway in dev mode needs no token; otherwise the browser needs an issuer
	// and a client id to run a flow at all.
	view.Connectable = d.AuthDisabled || (d.Issuer != "" && d.ClientID != "")
	if !view.Connectable && view.Error == "" {
		view.Error = "gateway did not advertise an OIDC issuer and client id"
	}
	return view
}

// maskFeatures intersects what a gateway offers with what the embedding can carry.
// A gateway admin is never asked to disable a feature in their own console so that
// RHOAI can embed it — the limitation belongs to the embedding, so it is applied here.
func maskFeatures(declared map[string]bool) map[string]bool {
	masked := make(map[string]bool, len(declared))
	for name, enabled := range declared {
		masked[name] = enabled
	}
	for _, name := range embeddedUnsupportedFeatures {
		if _, present := masked[name]; present {
			masked[name] = false
		}
	}
	return masked
}
