package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// An OpenShell install is a gateway plus its own relay BFF, bound together by
// OPENSHELL_GATEWAY_URL on that BFF. Multi-gateway is therefore multi-install,
// and this registry is the dashboard's view of which installs exist.
//
// Each install advertises its own identity domain through the public, unauthenticated
// GET /api/v1/auth/config on its BFF. The dashboard never hardcodes an issuer: it
// asks each gateway who it trusts, which keeps the value that mints Token B and the
// value that validates it from drifting apart.

// gatewayIDPattern constrains an ID to a DNS-1123 label. The ID is a URL path
// segment and a map key, so it is validated at load rather than at use.
var gatewayIDPattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// embeddedUnsupportedFeatures are capabilities a gateway may legitimately offer on
// its own standalone console but which the RHOAI embedding cannot carry. Terminal
// needs a WebSocket, and a browser cannot put a bearer on a protocol upgrade, so
// the embedded surface masks it off. The gateway's own console keeps it.
var embeddedUnsupportedFeatures = []string{"terminal"}

// Gateway is one OpenShell install as configured for this dashboard.
type Gateway struct {
	// ID is the stable path segment: /openshell/{id}/...
	ID string `json:"id"`
	// Name is what the gateway switcher shows.
	Name string `json:"name"`
	// BFFURL is the in-cluster base URL of that install's relay BFF. This is the
	// reverse-proxy target — not the gateway's gRPC endpoint, and not its public route.
	BFFURL string `json:"bffUrl"`
	// ConsoleURL is the install's public standalone route. Used only to link out for
	// capabilities the embedding cannot carry; never proxied through.
	ConsoleURL string `json:"consoleUrl,omitempty"`
}

// Discovery is the subset of a gateway BFF's /api/v1/auth/config that the browser
// needs in order to obtain a token for that gateway.
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

type registryEntry struct {
	fetchedAt time.Time
	disco     *Discovery
	discoErr  string
	gateway   Gateway
}

// GatewayRegistry holds the configured installs and caches what each one says
// about itself. Discovery is cached with a TTL so a gateway that rotates its
// issuer is picked up without a dashboard restart.
type GatewayRegistry struct {
	client  *http.Client
	logger  *slog.Logger
	entries map[string]*registryEntry
	order   []string
	ttl     time.Duration
	mu      sync.RWMutex
}

// ParseGateways reads the OPENSHELL_GATEWAYS JSON array. An empty value yields no
// gateways, which disables the OpenShell area rather than failing startup.
func ParseGateways(raw string) ([]Gateway, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}

	var gateways []Gateway
	if err := json.Unmarshal([]byte(raw), &gateways); err != nil {
		return nil, fmt.Errorf("OPENSHELL_GATEWAYS is not a valid JSON array: %w", err)
	}

	seen := make(map[string]struct{}, len(gateways))
	for i := range gateways {
		g := &gateways[i]
		g.ID = strings.TrimSpace(g.ID)
		g.BFFURL = strings.TrimRight(strings.TrimSpace(g.BFFURL), "/")
		g.ConsoleURL = strings.TrimRight(strings.TrimSpace(g.ConsoleURL), "/")

		if !gatewayIDPattern.MatchString(g.ID) {
			return nil, fmt.Errorf("gateway id %q is not a DNS-1123 label", g.ID)
		}
		if _, dup := seen[g.ID]; dup {
			return nil, fmt.Errorf("duplicate gateway id %q", g.ID)
		}
		seen[g.ID] = struct{}{}

		if g.BFFURL == "" {
			return nil, fmt.Errorf("gateway %q has no bffUrl", g.ID)
		}
		if !strings.HasPrefix(g.BFFURL, "http://") && !strings.HasPrefix(g.BFFURL, "https://") {
			return nil, fmt.Errorf("gateway %q bffUrl must be http(s): %q", g.ID, g.BFFURL)
		}
		if g.Name == "" {
			g.Name = g.ID
		}
	}
	return gateways, nil
}

// NewGatewayRegistry builds a registry over the configured installs. The HTTP client
// honours the app's trusted CA pool so in-cluster serving certs validate.
func NewGatewayRegistry(gateways []Gateway, rootCAs *x509.CertPool, insecure bool, logger *slog.Logger) *GatewayRegistry {
	r := &GatewayRegistry{
		entries: make(map[string]*registryEntry, len(gateways)),
		order:   make([]string, 0, len(gateways)),
		ttl:     5 * time.Minute,
		logger:  logger,
		client: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					RootCAs:            rootCAs,
					InsecureSkipVerify: insecure, //nolint:gosec // config-gated (INSECURE_SKIP_VERIFY), dev/POC only
				},
			},
		},
	}
	for _, g := range gateways {
		r.entries[g.ID] = &registryEntry{gateway: g}
		r.order = append(r.order, g.ID)
	}
	return r
}

// Len reports how many installs are configured.
func (r *GatewayRegistry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.order)
}

// Lookup returns the configured gateway for an ID.
func (r *GatewayRegistry) Lookup(id string) (Gateway, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	entry, ok := r.entries[id]
	if !ok {
		return Gateway{}, false
	}
	return entry.gateway, true
}

// Views returns every gateway with its discovery state, refreshing any entry whose
// cache has expired. Used by the switcher.
func (r *GatewayRegistry) Views(ctx context.Context) []GatewayView {
	r.mu.RLock()
	ids := append([]string(nil), r.order...)
	r.mu.RUnlock()

	views := make([]GatewayView, 0, len(ids))
	for _, id := range ids {
		views = append(views, r.View(ctx, id))
	}
	return views
}

// View returns one gateway with its discovery state, refreshing if stale.
func (r *GatewayRegistry) View(ctx context.Context, id string) GatewayView {
	r.mu.RLock()
	entry, ok := r.entries[id]
	var (
		gateway Gateway
		disco   *Discovery
		errMsg  string
		fresh   bool
	)
	if ok {
		gateway = entry.gateway
		disco = entry.disco
		errMsg = entry.discoErr
		fresh = !entry.fetchedAt.IsZero() && time.Since(entry.fetchedAt) < r.ttl
	}
	r.mu.RUnlock()

	if !ok {
		return GatewayView{ID: id, Name: id, Error: "unknown gateway"}
	}

	if !fresh {
		disco, errMsg = r.refresh(ctx, gateway)
	}

	view := GatewayView{
		ID:         gateway.ID,
		Name:       gateway.Name,
		ConsoleURL: gateway.ConsoleURL,
		Error:      errMsg,
		Features:   map[string]bool{},
	}
	if disco != nil {
		view.Issuer = disco.Issuer
		view.ClientID = disco.ClientID
		view.Audience = disco.Audience
		view.Scope = disco.Scope
		view.APIVersion = disco.APIVersion
		view.AuthDisabled = disco.AuthDisabled
		view.Features = maskFeatures(disco.Features)
		// A gateway in dev mode needs no token; otherwise the browser needs an
		// issuer and a client id to run a flow at all.
		view.Connectable = disco.AuthDisabled || (disco.Issuer != "" && disco.ClientID != "")
		if !view.Connectable && view.Error == "" {
			view.Error = "gateway did not advertise an OIDC issuer and client id"
		}
	}
	return view
}

// refresh fetches /api/v1/auth/config from a gateway's BFF and stores the result.
func (r *GatewayRegistry) refresh(ctx context.Context, gateway Gateway) (*Discovery, string) {
	disco, err := r.fetchDiscovery(ctx, gateway)

	var errMsg string
	if err != nil {
		errMsg = err.Error()
		r.logger.Warn("OpenShell gateway discovery failed",
			slog.String("gateway", gateway.ID), slog.Any("error", err))
	}

	r.mu.Lock()
	if entry, ok := r.entries[gateway.ID]; ok {
		// Keep the last good discovery on a transient failure so one flaky fetch
		// does not make a working gateway look unconnectable.
		if disco != nil {
			entry.disco = disco
		}
		entry.discoErr = errMsg
		entry.fetchedAt = time.Now()
		disco = entry.disco
	}
	r.mu.Unlock()

	return disco, errMsg
}

func (r *GatewayRegistry) fetchDiscovery(ctx context.Context, gateway Gateway) (*Discovery, error) {
	url := gateway.BFFURL + "/api/v1/auth/config"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("building discovery request: %w", err)
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gateway BFF unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gateway BFF returned HTTP %d from /api/v1/auth/config", resp.StatusCode)
	}

	var disco Discovery
	if err := json.NewDecoder(resp.Body).Decode(&disco); err != nil {
		return nil, fmt.Errorf("gateway BFF returned an unreadable auth config: %w", err)
	}
	return &disco, nil
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
