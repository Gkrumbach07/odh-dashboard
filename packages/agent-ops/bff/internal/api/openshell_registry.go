package api

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	openshellapi "github.com/Gkrumbach07/openshell-dashboard/backend/pkg/api"
	openshellauth "github.com/Gkrumbach07/openshell-dashboard/backend/pkg/auth"
	openshellsdk "github.com/Gkrumbach07/openshell-dashboard/backend/pkg/sdkclient"

	"github.com/opendatahub-io/mod-arch-library/bff/pkg/fleet"
)

// OpenShell-specific half of the gateway fleet.
//
// The upstream OpenShell BFF is *embedded*, not proxied to: its handlers are
// imported from pkg/api and mounted per gateway, so one process fronts every
// install and there is no relay service to deploy or extra network hop. An App
// is bound to one gateway by its SDK client, so N gateways is N Apps — no
// per-request client factory is needed, because ContextAuthProvider already
// resolves the caller's bearer per request.
//
// Generic routing, discovery, readiness and backoff live in pkg/fleet.

// Gateway is one OpenShell install as configured for this dashboard.
type Gateway struct {
	// ID is the stable path segment: /openshell/{id}/...
	ID string `json:"id"`
	// Name is what the gateway switcher shows.
	Name string `json:"name"`
	// GatewayURL is the gateway's gRPC endpoint. Accepts grpc(s)://, http(s)://
	// or a bare host:port.
	GatewayURL string `json:"gatewayUrl"`

	// Public OIDC client metadata for this gateway's identity domain. These must
	// match what the gateway itself was started with (--oidc-issuer /
	// --oidc-audience): a mismatch surfaces only as a gateway refusal, with no
	// useful diagnostic anywhere earlier.
	Issuer   string `json:"issuer"`
	ClientID string `json:"clientId"`
	Audience string `json:"audience"`
	Scope    string `json:"scope"`

	// ConsoleURL optionally links out to this install's standalone console for
	// capabilities the embedding cannot carry, such as the terminal.
	ConsoleURL string `json:"consoleUrl"`

	// Optional TLS material for the gateway connection.
	CACert     string `json:"caCert"`
	ClientCert string `json:"clientCert"`
	ClientKey  string `json:"clientKey"`
}

// Discovery is what a gateway reports about itself once reached. Unlike the
// proxied design this is the gateway's own answer over gRPC, so readiness now
// reflects the gateway rather than an intermediary's HTTP endpoint.
type Discovery struct {
	GatewayVersion string   `json:"gatewayVersion,omitempty"`
	Status         string   `json:"status,omitempty"`
	ComputeDrivers []string `json:"computeDrivers,omitempty"`
}

// GatewayView is what the frontend receives for one gateway.
type GatewayView struct {
	Features       map[string]bool `json:"features"`
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	ConsoleURL     string          `json:"consoleUrl,omitempty"`
	Issuer         string          `json:"issuer,omitempty"`
	ClientID       string          `json:"clientId,omitempty"`
	Audience       string          `json:"audience,omitempty"`
	Scope          string          `json:"scope,omitempty"`
	GatewayVersion string          `json:"gatewayVersion,omitempty"`
	Error          string          `json:"error,omitempty"`
	Connectable    bool            `json:"connectable"`
}

// embeddedUnsupportedFeatures are capabilities a gateway offers on its own
// standalone console but which the embedding cannot carry. Terminal needs a
// WebSocket, and a browser cannot put a bearer on a protocol upgrade.
var embeddedUnsupportedFeatures = []string{"terminal"}

// OpenShellFleet owns one embedded App per configured gateway.
type OpenShellFleet struct {
	registry *fleet.Registry[Discovery]
	gateways map[string]Gateway
	apps     map[string]*openshellapi.App
	clients  map[string]*openshellsdk.GatewayClients
	backends []fleet.Backend
}

// ParseGateways reads the OPENSHELL_GATEWAYS JSON array.
func ParseGateways(raw string) ([]Gateway, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}

	var gateways []Gateway
	if err := json.Unmarshal([]byte(raw), &gateways); err != nil {
		return nil, fmt.Errorf("OPENSHELL_GATEWAYS is not a valid JSON array: %w", err)
	}

	backends := make([]fleet.Backend, 0, len(gateways))
	for i := range gateways {
		g := &gateways[i]
		g.ID = strings.TrimSpace(g.ID)
		g.GatewayURL = strings.TrimSpace(g.GatewayURL)
		if g.GatewayURL == "" {
			return nil, fmt.Errorf("gateway %q has no gatewayUrl", g.ID)
		}
		// URL is left empty: an embedded backend is served in-process, so there
		// is no HTTP target for fleet to proxy to.
		backends = append(backends, fleet.Backend{ID: g.ID, Name: g.Name, LinkURL: g.ConsoleURL})
	}
	if err := fleet.Validate(backends); err != nil {
		return nil, err
	}
	for i := range gateways {
		gateways[i].Name = backends[i].Name // Validate defaults Name to ID
	}
	return gateways, nil
}

// NewOpenShellFleet dials every configured gateway and builds an embedded App
// for each. A gateway that cannot be dialled fails startup: a bad endpoint is a
// configuration error, and discovery — which runs later and retries — is for a
// gateway that is merely not up yet.
func NewOpenShellFleet(gateways []Gateway, rootCAs *x509.CertPool, logger *slog.Logger) (*OpenShellFleet, error) {
	f := &OpenShellFleet{
		gateways: make(map[string]Gateway, len(gateways)),
		apps:     make(map[string]*openshellapi.App, len(gateways)),
		clients:  make(map[string]*openshellsdk.GatewayClients, len(gateways)),
		backends: make([]fleet.Backend, 0, len(gateways)),
	}

	for _, g := range gateways {
		clients, err := openshellsdk.NewGatewayClients(g.GatewayURL, g.CACert, g.ClientCert, g.ClientKey)
		if err != nil {
			f.Close()
			return nil, fmt.Errorf("gateway %q: %w", g.ID, err)
		}

		// staticDir "" keeps this API-only: the embedding host renders the UI
		// from the npm package, not from the console's static assets.
		app := openshellapi.NewApp(
			clients.SDK,
			clients.UploadExec,
			openshellauth.New(openshellauth.Config{}),
			"",
			openshellapi.AuthConfigResponse{
				Issuer:   g.Issuer,
				ClientID: g.ClientID,
				Audience: g.Audience,
				Scope:    g.Scope,
				Features: embeddedFeatureFlags(),
			},
		)

		f.gateways[g.ID] = g
		f.clients[g.ID] = clients
		f.apps[g.ID] = app
		f.backends = append(f.backends, fleet.Backend{ID: g.ID, Name: g.Name, LinkURL: g.ConsoleURL})
	}

	f.registry = fleet.New(f.backends, f.discover, fleet.Options{Logger: logger})
	return f, nil
}

// embeddedFeatureFlags is what each embedded App advertises on its own
// /auth/config. Masking here rather than downstream means a gateway admin is
// never asked to disable a feature in their own console so this can embed it.
func embeddedFeatureFlags() openshellapi.FeatureFlags {
	flags := openshellapi.FeatureFlags{
		Terminal:          true,
		FileTransfer:      true,
		Settings:          true,
		GlobalPolicy:      true,
		CredentialRefresh: true,
		Services:          true,
		DraftPolicy:       true,
	}
	for _, name := range embeddedUnsupportedFeatures {
		if name == "terminal" {
			flags.Terminal = false
		}
	}
	return flags
}

// discover asks the gateway itself whether it is reachable, over gRPC.
func (f *OpenShellFleet) discover(ctx context.Context, b fleet.Backend, _ *http.Client) (Discovery, error) {
	var d Discovery
	clients, ok := f.clients[b.ID]
	if !ok {
		return d, fmt.Errorf("no client for gateway %q", b.ID)
	}

	info, err := clients.SDK.Health().GetGatewayInfo(ctx)
	if err != nil {
		return d, fmt.Errorf("gateway unreachable: %w", err)
	}
	d.GatewayVersion = info.Version
	d.Status = fmt.Sprintf("%v", info.Status)
	for _, drv := range info.ComputeDrivers {
		d.ComputeDrivers = append(d.ComputeDrivers, drv.Name)
	}
	return d, nil
}

// Len reports how many gateways are configured.
func (f *OpenShellFleet) Len() int {
	if f == nil {
		return 0
	}
	return len(f.backends)
}

// Lookup and Ready satisfy the fleet.Router hooks.
func (f *OpenShellFleet) Lookup(id string) (fleet.Backend, bool) { return f.registry.Lookup(id) }
func (f *OpenShellFleet) Ready(id string) bool                   { return f.registry.Ready(id) }

// Handler returns the embedded App for a gateway.
func (f *OpenShellFleet) Handler(b fleet.Backend) (http.Handler, error) {
	app, ok := f.apps[b.ID]
	if !ok {
		return nil, fmt.Errorf("no app for gateway %q", b.ID)
	}
	return mapRefusals(app.Routes(), b.Name), nil
}

// Start begins background discovery so a gateway that is down at boot recovers
// on its own rather than staying unconnectable until someone reloads.
func (f *OpenShellFleet) Start(ctx context.Context) {
	if f != nil && f.registry != nil {
		f.registry.Start(ctx)
	}
}

// Close stops discovery and releases every gateway connection.
func (f *OpenShellFleet) Close() {
	if f == nil {
		return
	}
	if f.registry != nil {
		f.registry.Stop()
	}
	for _, c := range f.clients {
		c.Close()
	}
}

// Views renders every gateway for the frontend.
func (f *OpenShellFleet) Views(ctx context.Context) []GatewayView {
	views := []GatewayView{}
	if f == nil || f.registry == nil {
		return views
	}
	for _, e := range f.registry.Entries(ctx) {
		views = append(views, f.viewOf(e))
	}
	return views
}

func (f *OpenShellFleet) viewOf(e fleet.Entry[Discovery]) GatewayView {
	g := f.gateways[e.Backend.ID]
	view := GatewayView{
		ID:         g.ID,
		Name:       e.Backend.Name,
		ConsoleURL: g.ConsoleURL,
		Issuer:     g.Issuer,
		ClientID:   g.ClientID,
		Audience:   g.Audience,
		Scope:      g.Scope,
		Error:      e.Err,
		Features:   maskFeatures(nil),
	}
	if !e.Ready {
		if view.Error == "" {
			view.Error = "gateway has not been reached yet"
		}
		return view
	}

	view.GatewayVersion = e.Discovery.GatewayVersion
	// The browser needs an issuer and a client id to run a flow at all.
	view.Connectable = g.Issuer != "" && g.ClientID != ""
	if !view.Connectable {
		view.Error = "gateway has no OIDC issuer and client id configured"
	}
	return view
}

// maskFeatures reports the embedded feature surface, masking what the embedding
// cannot carry. A nil argument yields the defaults.
func maskFeatures(declared map[string]bool) map[string]bool {
	masked := map[string]bool{
		"terminal": true, "fileTransfer": true, "settings": true,
		"globalPolicy": true, "credentialRefresh": true,
		"services": true, "draftPolicy": true,
	}
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
