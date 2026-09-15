package fleet_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opendatahub-io/mod-arch-library/bff/pkg/fleet"
)

type doc struct {
	Issuer string `json:"issuer"`
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func httpDiscover(ctx context.Context, b fleet.Backend, c *http.Client) (doc, error) {
	var d doc
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.URL+"/disco", nil)
	if err != nil {
		return d, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return d, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return d, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return d, json.NewDecoder(resp.Body).Decode(&d)
}

func TestParseBackends(t *testing.T) {
	t.Run("accepts the canonical shape and the domain aliases", func(t *testing.T) {
		got, err := fleet.ParseBackends(
			`[{"id":"a","url":"https://a/"},{"id":"b","bffUrl":"https://b","consoleUrl":"https://b-ui"}]`)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("len = %d, want 2", len(got))
		}
		if got[0].URL != "https://a" {
			t.Errorf("trailing slash not trimmed: %q", got[0].URL)
		}
		if got[1].URL != "https://b" || got[1].LinkURL != "https://b-ui" {
			t.Errorf("aliases not honoured: %+v", got[1])
		}
		if got[0].Name != "a" {
			t.Errorf("name should default to id, got %q", got[0].Name)
		}
	})

	t.Run("empty is not an error", func(t *testing.T) {
		got, err := fleet.ParseBackends("  ")
		if err != nil || len(got) != 0 {
			t.Fatalf("got %v, %v", got, err)
		}
	})

	t.Run("rejects unsafe ids, duplicates and bad urls", func(t *testing.T) {
		for _, raw := range []string{
			`[{"id":"../x","url":"https://a"}]`,
			`[{"id":"Caps","url":"https://a"}]`,
			`[{"id":"a","url":"https://a"},{"id":"a","url":"https://b"}]`,
			`[{"id":"a"}]`,
			`[{"id":"a","url":"ftp://a"}]`,
			`nonsense`,
		} {
			if _, err := fleet.ParseBackends(raw); err == nil {
				t.Errorf("expected rejection for %s", raw)
			}
		}
	})
}

func TestSplitPath(t *testing.T) {
	for _, c := range []struct{ in, id, rest string }{
		{"/p/a/x/y", "a", "/x/y"},
		{"/p/a/", "a", "/"},
		{"/p/a", "a", "/"},
		{"/p/", "", "/"},
	} {
		id, rest := fleet.SplitPath("/p", c.in)
		if id != c.id || rest != c.rest {
			t.Errorf("SplitPath(%q) = %q,%q want %q,%q", c.in, id, rest, c.id, c.rest)
		}
	}
}

func TestRegistryDiscovery(t *testing.T) {
	t.Run("keeps the last good document when a refresh fails", func(t *testing.T) {
		var healthy atomic.Bool
		healthy.Store(true)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if !healthy.Load() {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(w).Encode(doc{Issuer: "https://idp"})
		}))
		defer srv.Close()

		r := fleet.New([]fleet.Backend{{ID: "a", Name: "a", URL: srv.URL}},
			httpDiscover, fleet.Options{Logger: quietLogger(), TTL: time.Nanosecond})

		e, ok := r.Entry(context.Background(), "a")
		if !ok || !e.Ready || e.Discovery.Issuer != "https://idp" {
			t.Fatalf("first discovery failed: %+v", e)
		}

		// TTL is 1ns so the next read always refreshes — and that refresh fails.
		healthy.Store(false)
		e, _ = r.Entry(context.Background(), "a")
		if !e.Ready {
			t.Error("a transient failure must not take a working backend out of service")
		}
		if e.Discovery.Issuer != "https://idp" {
			t.Errorf("last good document lost: %+v", e.Discovery)
		}
		if e.Err == "" {
			t.Error("the failure should still be reported")
		}
	})

	t.Run("an unreachable backend is never ready", func(t *testing.T) {
		r := fleet.New([]fleet.Backend{{ID: "down", Name: "down", URL: "https://127.0.0.1:1"}},
			httpDiscover, fleet.Options{Logger: quietLogger(), AttemptTimeout: time.Second})

		e, ok := r.Entry(context.Background(), "down")
		if !ok {
			t.Fatal("entry missing")
		}
		if e.Ready || r.Ready("down") {
			t.Error("unreachable backend must not report ready")
		}
		if e.Err == "" {
			t.Error("expected an error to be recorded")
		}
	})

	t.Run("unknown ids are reported, not invented", func(t *testing.T) {
		r := fleet.New[doc](nil, httpDiscover, fleet.Options{Logger: quietLogger()})
		if _, ok := r.Lookup("nope"); ok {
			t.Error("Lookup invented a backend")
		}
		if _, ok := r.Entry(context.Background(), "nope"); ok {
			t.Error("Entry invented a backend")
		}
	})
}

// This is the behaviour borrowed from the MaaS BFF: a backend that is down when the
// process starts must heal on its own rather than staying broken until a restart.
func TestRegistryBackgroundRetryRecovers(t *testing.T) {
	var up atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if !up.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(doc{Issuer: "https://idp"})
	}))
	defer srv.Close()

	r := fleet.New([]fleet.Backend{{ID: "a", Name: "a", URL: srv.URL}},
		httpDiscover, fleet.Options{
			Logger:         quietLogger(),
			AttemptTimeout: time.Second,
			InitialBackoff: 10 * time.Millisecond,
			MaxBackoff:     20 * time.Millisecond,
		})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.Start(ctx)
	defer r.Stop()

	// Start is async, so the process is not blocked while the backend is down.
	up.Store(true)

	deadline := time.After(5 * time.Second)
	for !r.Ready("a") {
		select {
		case <-deadline:
			t.Fatal("backend never recovered")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestRouter(t *testing.T) {
	newFleet := func(t *testing.T, url string) *fleet.Registry[doc] {
		t.Helper()
		r := fleet.New([]fleet.Backend{{ID: "a", Name: "Alpha", URL: url}},
			httpDiscover, fleet.Options{Logger: quietLogger(), AttemptTimeout: time.Second})
		r.Entries(context.Background())
		return r
	}

	t.Run("routes to the backend and runs the rewrite hook", func(t *testing.T) {
		var gotPath, gotHeader string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Path == "/disco" {
				_ = json.NewEncoder(w).Encode(doc{Issuer: "https://idp"})
				return
			}
			gotPath = req.URL.Path
			gotHeader = req.Header.Get("X-Swapped")
		}))
		defer srv.Close()

		reg := newFleet(t, srv.URL)
		router := &fleet.Router{
			Prefix: "/p", Backends: reg, Readiness: reg, Logger: quietLogger(),
			Rewrite: func(req *http.Request, b fleet.Backend) {
				req.Header.Del("X-Host-Credential")
				req.Header.Set("X-Swapped", b.ID)
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/p/a/v1/things", nil)
		req.Header.Set("X-Host-Credential", "secret")
		router.ServeHTTP(httptest.NewRecorder(), req)

		if gotPath != "/v1/things" {
			t.Errorf("path = %q, want /v1/things", gotPath)
		}
		if gotHeader != "a" {
			t.Errorf("rewrite hook did not run (X-Swapped=%q)", gotHeader)
		}
	})

	t.Run("gates on readiness and names errors with the consumer's codes", func(t *testing.T) {
		reg := fleet.New([]fleet.Backend{{ID: "a", Name: "Alpha", URL: "https://127.0.0.1:1"}},
			httpDiscover, fleet.Options{Logger: quietLogger(), AttemptTimeout: time.Second})
		router := &fleet.Router{
			Prefix: "/p", Backends: reg, Readiness: reg, Logger: quietLogger(),
			RejectUpgrades: true,
			Codes: fleet.Codes{
				NotReady: "mine_not_ready", UnknownID: "mine_unknown",
				MissingID: "mine_missing", UpgradeUnsupported: "mine_no_upgrade",
			},
		}

		for _, c := range []struct {
			name, path, code string
			status           int
			upgrade          bool
		}{
			{"not ready", "/p/a/x", "mine_not_ready", http.StatusServiceUnavailable, false},
			{"unknown", "/p/zzz/x", "mine_unknown", http.StatusNotFound, false},
			{"missing", "/p/", "mine_missing", http.StatusNotFound, false},
			{"upgrade", "/p/a/x", "mine_no_upgrade", http.StatusNotImplemented, true},
		} {
			req := httptest.NewRequest(http.MethodGet, c.path, nil)
			if c.upgrade {
				req.Header.Set("Upgrade", "websocket")
			}
			rr := httptest.NewRecorder()
			router.ServeHTTP(rr, req)

			if rr.Code != c.status {
				t.Errorf("%s: status = %d, want %d", c.name, rr.Code, c.status)
			}
			var body map[string]string
			if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
				t.Fatalf("%s: body not JSON: %v", c.name, err)
			}
			if body["code"] != c.code {
				t.Errorf("%s: code = %q, want %q", c.name, body["code"], c.code)
			}
		}
	})
}

// Membership changes when a fleet is discovered rather than configured, so the
// registry has to absorb that without losing what it already knows.
func TestSetBackendsAddsAndRemovesWithoutDisturbingSurvivors(t *testing.T) {
	calls := map[string]int{}
	r := fleet.New([]fleet.Backend{{ID: "a", Name: "A"}, {ID: "b", Name: "B"}},
		func(_ context.Context, b fleet.Backend, _ *http.Client) (string, error) {
			calls[b.ID]++
			return "doc-" + b.ID, nil
		}, fleet.Options{Logger: quietLogger()})

	// Prime both so "a" has a cached document to preserve.
	r.Entries(context.Background())
	if !r.Ready("a") || !r.Ready("b") {
		t.Fatalf("setup: both backends should be ready")
	}

	added, removed := r.SetBackends([]fleet.Backend{{ID: "a", Name: "A renamed"}, {ID: "c", Name: "C"}})
	if len(added) != 1 || added[0] != "c" {
		t.Errorf("added = %v, want [c]", added)
	}
	if len(removed) != 1 || removed[0] != "b" {
		t.Errorf("removed = %v, want [b]", removed)
	}

	if _, stillThere := r.Lookup("b"); stillThere {
		t.Error("a removed backend must stop resolving")
	}

	// "a" survived: it keeps its readiness, so a resync does not briefly take a
	// working backend out of service, and its Backend struct is refreshed.
	if !r.Ready("a") {
		t.Error("a surviving backend must stay ready across a resync")
	}
	kept, ok := r.Lookup("a")
	if !ok || kept.Name != "A renamed" {
		t.Errorf("surviving backend not refreshed: %+v (found=%v)", kept, ok)
	}
	if calls["a"] != 1 {
		t.Errorf("a surviving backend was rediscovered %d times, want 1", calls["a"])
	}

	// "c" is new and therefore not yet routable.
	if r.Ready("c") {
		t.Error("a newly added backend must not be routable before discovery")
	}
}

func TestSetBackendsToEmptyClearsTheFleet(t *testing.T) {
	r := fleet.New([]fleet.Backend{{ID: "a"}},
		func(context.Context, fleet.Backend, *http.Client) (string, error) { return "", nil },
		fleet.Options{Logger: quietLogger()})

	_, removed := r.SetBackends(nil)
	if len(removed) != 1 || removed[0] != "a" {
		t.Errorf("removed = %v, want [a]", removed)
	}
	if r.Len() != 0 {
		t.Errorf("Len = %d, want 0", r.Len())
	}
	if got := r.Entries(context.Background()); len(got) != 0 {
		t.Errorf("Entries = %v, want none", got)
	}
}

// The router caches handlers by backend id, and an id outlives what it points at.
// Without invalidation a rediscovered backend keeps being served by the handler
// built for its previous configuration.
func TestRouterForgetRebuildsTheHandler(t *testing.T) {
	built := 0
	r := &fleet.Router{
		Prefix:   "/p",
		Backends: staticLookup{{ID: "a", Name: "A"}},
		Handlers: func(fleet.Backend) (http.Handler, error) {
			built++
			return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}), nil
		},
		Logger: quietLogger(),
	}

	serve := func() {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/p/a/thing", nil))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
		}
	}

	serve()
	serve()
	if built != 1 {
		t.Fatalf("handler built %d times, want 1 (handlers are cached)", built)
	}

	r.Forget("a")
	serve()
	if built != 2 {
		t.Errorf("handler built %d times after Forget, want 2", built)
	}
}

type staticLookup []fleet.Backend

func (s staticLookup) Lookup(id string) (fleet.Backend, bool) {
	for _, b := range s {
		if b.ID == id {
			return b, true
		}
	}
	return fleet.Backend{}, false
}
