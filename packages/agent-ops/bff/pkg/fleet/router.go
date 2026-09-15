package fleet

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
)

// Lookuper resolves a backend ID. *Registry satisfies it.
type Lookuper interface {
	Lookup(id string) (Backend, bool)
}

// ReadyChecker reports whether a backend has been discovered. *Registry satisfies it.
type ReadyChecker interface {
	Ready(id string) bool
}

// Codes names the error codes the Router emits so the consumer keeps a stable
// contract with its own frontend. Empty fields fall back to generic defaults.
type Codes struct {
	MissingID          string
	UnknownID          string
	NotReady           string
	Unreachable        string
	UpgradeUnsupported string
	NotConfigured      string
}

func (c Codes) or(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

// Router dispatches /{Prefix}/{id}/... to the matching backend.
//
// It owns the trust boundary: Rewrite runs on every proxied request, which is where
// a consumer swaps whichever credential the host injected for the one its backend
// actually accepts. Nothing here knows what those credentials are.
type Router struct {
	// Prefix is the path segment the router is mounted under, e.g. "/openshell".
	Prefix string
	// Backends resolves IDs. Required.
	Backends Lookuper
	// Readiness gates routing on discovery having succeeded. Optional; when nil,
	// requests are proxied regardless of discovery state.
	Readiness ReadyChecker
	// Transport is used for every outbound proxy connection. Optional, and
	// ignored when Handlers is set.
	Transport http.RoundTripper
	// Handlers returns the handler for a backend, letting a consumer serve it
	// in-process instead of proxying over the network. When nil, the Router
	// reverse-proxies to Backend.URL.
	//
	// This is what lets one process front several backends by *embedding* them —
	// importing each backend's own handler and mounting it — rather than running
	// a separate service per backend and forwarding HTTP to it. The result is
	// cached per backend id.
	Handlers func(b Backend) (http.Handler, error)
	// Rewrite adapts an outbound request for its backend — typically swapping
	// credentials. Runs after the target host is set. Optional but almost always
	// wanted: without it the host's own headers travel onward untouched.
	Rewrite func(req *http.Request, b Backend)
	// OnResponse may rewrite the backend's response, e.g. to map status codes onto
	// the consumer's error envelope. Optional.
	OnResponse func(resp *http.Response, b Backend) error
	// RejectUpgrades refuses protocol upgrades instead of forwarding them without
	// credentials. A browser cannot set headers on an upgrade, so a fleet fronted
	// by browser-held tokens cannot authenticate one.
	RejectUpgrades bool
	// WriteError renders an error. Optional; defaults to a {code,message} JSON body.
	WriteError func(w http.ResponseWriter, status int, code, message string)
	Logger     *slog.Logger
	Codes      Codes

	mu      sync.Mutex
	proxies map[string]http.Handler
}

func (r *Router) logger() *slog.Logger {
	if r.Logger != nil {
		return r.Logger
	}
	return slog.Default()
}

func (r *Router) fail(w http.ResponseWriter, status int, code, message string) {
	if r.WriteError != nil {
		r.WriteError(w, status, code, message)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"code":%q,"message":%q}`, code, message)
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if r.Backends == nil {
		r.fail(w, http.StatusServiceUnavailable,
			r.Codes.or(r.Codes.NotConfigured, "not_configured"),
			"No backends are configured for this deployment")
		return
	}

	if r.RejectUpgrades && strings.EqualFold(req.Header.Get("Upgrade"), "websocket") {
		r.fail(w, http.StatusNotImplemented,
			r.Codes.or(r.Codes.UpgradeUnsupported, "upgrade_unsupported"),
			"Protocol upgrades are not available through this proxy")
		return
	}

	id, rest := SplitPath(r.Prefix, req.URL.Path)
	if id == "" {
		r.fail(w, http.StatusNotFound,
			r.Codes.or(r.Codes.MissingID, "backend_missing"),
			fmt.Sprintf("Request path must name a backend: %s/{id}/...", r.Prefix))
		return
	}

	backend, ok := r.Backends.Lookup(id)
	if !ok {
		r.fail(w, http.StatusNotFound,
			r.Codes.or(r.Codes.UnknownID, "backend_unknown"),
			fmt.Sprintf("No backend named %q is configured", id))
		return
	}

	// A backend that has never been discovered is not routable: proxying to it
	// would surface a transport error instead of an honest "not ready yet".
	if r.Readiness != nil && !r.Readiness.Ready(id) {
		r.fail(w, http.StatusServiceUnavailable,
			r.Codes.or(r.Codes.NotReady, "backend_not_ready"),
			fmt.Sprintf("Backend %q is not ready yet", backend.Name))
		return
	}

	handler, err := r.handlerFor(backend)
	if err != nil {
		r.logger().Error("building backend handler failed",
			slog.String("backend", backend.ID), slog.Any("error", err))
		r.fail(w, http.StatusInternalServerError,
			r.Codes.or(r.Codes.UnknownID, "backend_misconfigured"),
			fmt.Sprintf("Backend %q is misconfigured", backend.Name))
		return
	}

	outbound := req.Clone(req.Context())
	outbound.URL.Path = rest
	handler.ServeHTTP(w, outbound)
}

// Forget drops cached handlers so the next request rebuilds them.
//
// The cache is keyed by backend ID, which stays stable while what it points at
// can change — a rediscovered backend may have a new URL, or new credentials
// baked into an embedded handler. Call this whenever membership or a backend's
// details change, or the router keeps serving the handler built for the old one.
func (r *Router) Forget(ids ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.proxies == nil {
		return
	}
	for _, id := range ids {
		delete(r.proxies, id)
	}
}

func (r *Router) handlerFor(backend Backend) (http.Handler, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.proxies == nil {
		r.proxies = map[string]http.Handler{}
	}
	if p, ok := r.proxies[backend.ID]; ok {
		return p, nil
	}

	// Embedded: the consumer supplies the backend's own handler.
	if r.Handlers != nil {
		h, err := r.Handlers(backend)
		if err != nil {
			return nil, err
		}
		r.proxies[backend.ID] = h
		return h, nil
	}

	if backend.URL == "" {
		return nil, fmt.Errorf("backend %q has no url and no Handlers hook is set", backend.ID)
	}
	target, err := url.Parse(backend.URL)
	if err != nil {
		return nil, fmt.Errorf("invalid url %q: %w", backend.URL, err)
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	if r.Transport != nil {
		proxy.Transport = r.Transport
	}

	origDirector := proxy.Director
	rewrite := r.Rewrite
	proxy.Director = func(req *http.Request) {
		origDirector(req)
		req.Host = target.Host
		if rewrite != nil {
			rewrite(req, backend)
		}
	}

	if r.OnResponse != nil {
		onResponse := r.OnResponse
		proxy.ModifyResponse = func(resp *http.Response) error {
			return onResponse(resp, backend)
		}
	}

	unreachable := r.Codes.or(r.Codes.Unreachable, "backend_unreachable")
	logger := r.logger()
	proxy.ErrorHandler = func(w http.ResponseWriter, req *http.Request, perr error) {
		logger.Error("reverse proxy error",
			slog.Any("error", perr),
			slog.String("backend", backend.ID),
			slog.String("path", req.URL.Path))
		r.fail(w, http.StatusBadGateway, unreachable,
			fmt.Sprintf("Backend %q is unavailable", backend.Name))
	}

	r.proxies[backend.ID] = proxy
	return proxy, nil
}

// SplitPath turns /{prefix}/{id}/rest into ("{id}", "/rest").
func SplitPath(prefix, p string) (id, rest string) {
	trimmed := strings.TrimPrefix(p, prefix)
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
