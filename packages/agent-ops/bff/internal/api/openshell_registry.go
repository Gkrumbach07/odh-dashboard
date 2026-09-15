package api

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

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

// DefaultResyncInterval is how often a cluster-backed fleet re-asks its source
// which gateways exist. Gateways are installed and removed by an operator, on
// human timescales, so this trades promptness for not hammering the API server.
const DefaultResyncInterval = 2 * time.Minute

// OpenShellFleet owns one embedded App per gateway, and keeps that set in step
// with whatever its GatewaySource reports.
type OpenShellFleet struct {
	source   GatewaySource
	registry *fleet.Registry[Discovery]
	router   *fleet.Router
	rootCAs  *x509.CertPool
	logger   *slog.Logger
	resync   time.Duration

	// mu guards everything below. It exists because membership is no longer fixed
	// at construction: a resync can add, replace or drop a gateway while requests
	// are being served against the others.
	mu       sync.RWMutex
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

// NewOpenShellFleet builds a fleet over a source and populates it once.
//
// An initial Sync failure is fatal: a source that cannot answer at startup is a
// configuration or RBAC problem — the wrong label selector, no permission to list
// Services — and starting with the OpenShell area silently empty is harder to
// diagnose than failing here. A source that answers with *no* gateways is not an
// error; the cluster may simply not have one installed yet, and the resync loop
// will pick one up when it appears.
func NewOpenShellFleet(ctx context.Context, source GatewaySource, rootCAs *x509.CertPool, logger *slog.Logger) (*OpenShellFleet, error) {
	f := &OpenShellFleet{
		source:   source,
		rootCAs:  rootCAs,
		logger:   logger,
		resync:   DefaultResyncInterval,
		gateways: map[string]Gateway{},
		apps:     map[string]*openshellapi.App{},
		clients:  map[string]*openshellsdk.GatewayClients{},
	}
	// Dynamic keeps the registry's retry loop alive after the fleet first goes
	// green, so a gateway discovered later is still reached without a restart.
	f.registry = fleet.New(nil, f.discover, fleet.Options{Logger: logger, Dynamic: true})
	f.router = f.newRouter()

	if err := f.Sync(ctx); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// Sync brings the fleet in line with its source.
//
// A source error leaves the fleet exactly as it was. That matters most for the
// cluster source: a transient API server error must not tear down every working
// gateway and log every user out, so "I could not tell" is treated as "no change"
// rather than as "there are none".
func (f *OpenShellFleet) Sync(ctx context.Context) error {
	desired, err := f.source.Gateways(ctx)
	if err != nil {
		return fmt.Errorf("discover gateways from %s: %w", f.source.Describe(), err)
	}

	backends := make([]fleet.Backend, 0, len(desired))
	for _, g := range desired {
		backends = append(backends, fleet.Backend{ID: g.ID, Name: g.Name, LinkURL: g.ConsoleURL})
	}
	if err := fleet.Validate(backends); err != nil {
		return fmt.Errorf("gateways from %s are invalid: %w", f.source.Describe(), err)
	}
	for i := range desired {
		desired[i].Name = backends[i].Name // Validate defaults Name to ID
	}

	f.mu.Lock()
	var (
		stale   []*openshellsdk.GatewayClients
		changed []string
	)
	keep := make(map[string]struct{}, len(desired))
	for i := range desired {
		g := desired[i]
		keep[g.ID] = struct{}{}

		// Gateway is all scalars, so equality is the whole config. Anything that
		// differs — a new issuer, a moved endpoint — means the embedded App was
		// built against details that no longer hold and has to be rebuilt.
		if existing, ok := f.gateways[g.ID]; ok && existing == g {
			continue
		}

		clients, err := openshellsdk.NewGatewayClients(g.GatewayURL, g.CACert, g.ClientCert, g.ClientKey)
		if err != nil {
			// One unusable endpoint must not cost the rest of the fleet. The
			// gateway is dropped from this sync and reappears if it is fixed.
			f.logger.Error("cannot connect to OpenShell gateway; excluding it from the fleet",
				slog.String("gateway", g.ID), slog.Any("error", err))
			delete(keep, g.ID)
			continue
		}

		if old, ok := f.clients[g.ID]; ok {
			stale = append(stale, old)
		}
		f.gateways[g.ID] = g
		f.clients[g.ID] = clients
		f.apps[g.ID] = newEmbeddedApp(clients, g)
		changed = append(changed, g.ID)
	}

	for id := range f.gateways {
		if _, ok := keep[id]; ok {
			continue
		}
		if c, ok := f.clients[id]; ok {
			stale = append(stale, c)
		}
		delete(f.gateways, id)
		delete(f.clients, id)
		delete(f.apps, id)
		changed = append(changed, id)
	}

	f.backends = f.backends[:0]
	for _, b := range backends {
		if _, ok := keep[b.ID]; ok {
			f.backends = append(f.backends, b)
		}
	}
	live := append([]fleet.Backend(nil), f.backends...)
	f.mu.Unlock()

	added, removed := f.registry.SetBackends(live)
	// The router caches handlers by gateway id, and an id outlives the App behind
	// it. Without this a rebuilt gateway keeps serving the App built for its old
	// configuration — the exact drift this discovery exists to remove.
	f.router.Forget(changed...)

	for _, c := range stale {
		c.Close()
	}

	if len(added) > 0 || len(removed) > 0 {
		f.logger.Info("OpenShell fleet membership changed",
			slog.Any("added", added),
			slog.Any("removed", removed),
			slog.String("source", f.source.Describe()))
	}
	return nil
}

// newEmbeddedApp builds the upstream OpenShell BFF bound to one gateway.
func newEmbeddedApp(clients *openshellsdk.GatewayClients, g Gateway) *openshellapi.App {
	// staticDir "" keeps this API-only: the embedding host renders the UI from
	// the npm package, not from the console's static assets.
	return openshellapi.NewApp(
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
	f.mu.RLock()
	clients, ok := f.clients[b.ID]
	f.mu.RUnlock()
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

// Len reports how many gateways are currently in the fleet.
func (f *OpenShellFleet) Len() int {
	if f == nil {
		return 0
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	return len(f.backends)
}

// Lookup and Ready satisfy the fleet.Router hooks.
func (f *OpenShellFleet) Lookup(id string) (fleet.Backend, bool) { return f.registry.Lookup(id) }
func (f *OpenShellFleet) Ready(id string) bool                   { return f.registry.Ready(id) }

// Handler returns the embedded App for a gateway.
func (f *OpenShellFleet) Handler(b fleet.Backend) (http.Handler, error) {
	f.mu.RLock()
	app, ok := f.apps[b.ID]
	f.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("no app for gateway %q", b.ID)
	}
	return mapRefusals(app.Routes(), b.Name), nil
}

// Router serves /openshell/{gatewayId}/... It is owned by the fleet rather than
// built per call so that Sync can invalidate its handler cache.
func (f *OpenShellFleet) Router() http.Handler { return f.router }

// Start begins background discovery, and — for a source whose answer can change —
// a resync loop, so a gateway installed or removed after startup is picked up
// without restarting the process.
func (f *OpenShellFleet) Start(ctx context.Context) {
	if f == nil || f.registry == nil {
		return
	}
	f.registry.Start(ctx)

	if f.resync <= 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(f.resync)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := f.Sync(ctx); err != nil {
					// Non-fatal by construction: Sync left the fleet untouched.
					f.logger.Warn("OpenShell gateway resync failed; keeping the current fleet",
						slog.Any("error", err))
				}
			}
		}
	}()
}

// Close stops discovery and releases every gateway connection.
func (f *OpenShellFleet) Close() {
	if f == nil {
		return
	}
	if f.registry != nil {
		f.registry.Stop()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.clients {
		c.Close()
	}
	f.clients = map[string]*openshellsdk.GatewayClients{}
	f.apps = map[string]*openshellapi.App{}
	f.gateways = map[string]Gateway{}
	f.backends = nil
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
	f.mu.RLock()
	g := f.gateways[e.Backend.ID]
	f.mu.RUnlock()
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
	// The browser needs an issuer and a client id to run a flow at all. The two
	// come from different places and are fixed in different places, so say which
	// is missing rather than reporting one opaque "not configured".
	var missing []string
	if g.Issuer == "" {
		missing = append(missing, "OIDC issuer (from the gateway's own config)")
	}
	if g.ClientID == "" {
		missing = append(missing, "OIDC client id (from the "+AnnotationClientID+" annotation on the gateway Service)")
	}
	view.Connectable = len(missing) == 0
	if !view.Connectable {
		view.Error = "gateway is missing " + strings.Join(missing, " and ")
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
