package fleet

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// Defaults mirror the discovery behaviour already proven in the MaaS BFF: a bounded
// attempt, then exponential backoff between retries rather than a tight loop.
const (
	DefaultTTL            = 5 * time.Minute
	DefaultAttemptTimeout = 15 * time.Second
	DefaultInitialBackoff = 5 * time.Second
	DefaultMaxBackoff     = 30 * time.Second
)

// DiscoverFunc asks a backend to describe itself. D is the consumer's own
// discovery document — fleet never interprets it.
type DiscoverFunc[D any] func(ctx context.Context, b Backend, client *http.Client) (D, error)

// Options tunes a Registry. Zero values fall back to the Default* constants.
type Options struct {
	Client         *http.Client
	Logger         *slog.Logger
	TTL            time.Duration
	AttemptTimeout time.Duration
	InitialBackoff time.Duration
	MaxBackoff     time.Duration
	// Dynamic keeps the background retry loop alive once every backend is ready,
	// instead of letting it finish. Set it when membership can change under
	// SetBackends: otherwise a backend added after the fleet first went green is
	// never retried, because the loop that would have retried it has exited.
	Dynamic bool
}

// Entry is a backend plus what it last said about itself.
type Entry[D any] struct {
	Backend   Backend
	Discovery D
	// Ready reports whether discovery has succeeded at least once. A backend that
	// has never been discovered is not routable.
	Ready bool
	// Err is the most recent discovery error. It can be set while Ready is true
	// when a refresh failed and the previous answer is still being served.
	Err    string
	LastOK time.Time
}

type entry[D any] struct {
	backend     Backend
	discovery   D
	ready       bool
	err         string
	lastOK      time.Time
	lastAttempt time.Time
	nextAttempt time.Time
	backoff     time.Duration
}

// Registry holds a fleet of backends and caches each one's discovery document.
//
// A backend that has never been discovered is kept out of service rather than
// routed to blindly, and is retried in the background with backoff — so a gateway
// that is slow to come up (or briefly down) heals without a restart.
type Registry[D any] struct {
	discover DiscoverFunc[D]
	opts     Options
	mu       sync.RWMutex
	entries  map[string]*entry[D]
	order    []string
	stop     context.CancelFunc
	stopOnce sync.Once
}

// New builds a Registry over already-validated backends.
func New[D any](backends []Backend, discover DiscoverFunc[D], opts Options) *Registry[D] {
	if opts.Client == nil {
		opts.Client = &http.Client{Timeout: 10 * time.Second}
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.TTL == 0 {
		opts.TTL = DefaultTTL
	}
	if opts.AttemptTimeout == 0 {
		opts.AttemptTimeout = DefaultAttemptTimeout
	}
	if opts.InitialBackoff == 0 {
		opts.InitialBackoff = DefaultInitialBackoff
	}
	if opts.MaxBackoff == 0 {
		opts.MaxBackoff = DefaultMaxBackoff
	}

	r := &Registry[D]{
		discover: discover,
		opts:     opts,
		entries:  make(map[string]*entry[D], len(backends)),
		order:    make([]string, 0, len(backends)),
	}
	for _, b := range backends {
		r.entries[b.ID] = &entry[D]{backend: b, backoff: opts.InitialBackoff}
		r.order = append(r.order, b.ID)
	}
	return r
}

// SetBackends replaces the fleet's membership, returning the IDs that were added
// and removed.
//
// A backend that is still present keeps its cached discovery document and its
// backoff state, so re-running discovery does not take a working backend briefly
// out of service. Only its Backend struct is refreshed, because a backend can be
// rediscovered with new details under the same ID.
//
// This is what makes membership dynamic: a fleet discovered from the cluster
// changes when the cluster does, without restarting the process.
func (r *Registry[D]) SetBackends(backends []Backend) (added, removed []string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	seen := make(map[string]struct{}, len(backends))
	order := make([]string, 0, len(backends))
	for _, b := range backends {
		seen[b.ID] = struct{}{}
		order = append(order, b.ID)
		if existing, ok := r.entries[b.ID]; ok {
			existing.backend = b
			continue
		}
		r.entries[b.ID] = &entry[D]{backend: b, backoff: r.opts.InitialBackoff}
		added = append(added, b.ID)
	}

	for id := range r.entries {
		if _, ok := seen[id]; !ok {
			delete(r.entries, id)
			removed = append(removed, id)
		}
	}

	r.order = order
	return added, removed
}

// Len reports how many backends are configured.
func (r *Registry[D]) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.order)
}

// Lookup returns the configured backend for an ID.
func (r *Registry[D]) Lookup(id string) (Backend, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[id]
	if !ok {
		return Backend{}, false
	}
	return e.backend, true
}

// Ready reports whether a backend has been discovered at least once.
func (r *Registry[D]) Ready(id string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[id]
	return ok && e.ready
}

// Entry returns one backend's state, refreshing first when the cached answer is
// stale or absent.
func (r *Registry[D]) Entry(ctx context.Context, id string) (Entry[D], bool) {
	r.mu.RLock()
	e, ok := r.entries[id]
	var fresh bool
	if ok {
		fresh = e.ready && time.Since(e.lastOK) < r.opts.TTL
	}
	r.mu.RUnlock()

	if !ok {
		return Entry[D]{}, false
	}
	if !fresh {
		r.refresh(ctx, id)
	}
	return r.snapshot(id)
}

// Entries returns every backend's state, refreshing any that are stale.
func (r *Registry[D]) Entries(ctx context.Context) []Entry[D] {
	r.mu.RLock()
	ids := append([]string(nil), r.order...)
	r.mu.RUnlock()

	out := make([]Entry[D], 0, len(ids))
	for _, id := range ids {
		if e, ok := r.Entry(ctx, id); ok {
			out = append(out, e)
		}
	}
	return out
}

func (r *Registry[D]) snapshot(id string) (Entry[D], bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[id]
	if !ok {
		return Entry[D]{}, false
	}
	return Entry[D]{
		Backend:   e.backend,
		Discovery: e.discovery,
		Ready:     e.ready,
		Err:       e.err,
		LastOK:    e.lastOK,
	}, true
}

// refresh performs one discovery attempt and stores the outcome. A failed refresh
// keeps the previous discovery document so one flaky fetch cannot take a working
// backend out of service.
func (r *Registry[D]) refresh(ctx context.Context, id string) {
	r.mu.RLock()
	e, ok := r.entries[id]
	backend := Backend{}
	if ok {
		backend = e.backend
	}
	r.mu.RUnlock()
	if !ok {
		return
	}

	attemptCtx, cancel := context.WithTimeout(ctx, r.opts.AttemptTimeout)
	doc, err := r.discover(attemptCtx, backend, r.opts.Client)
	cancel()

	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok = r.entries[id]
	if !ok {
		return
	}
	e.lastAttempt = time.Now()
	if err != nil {
		e.err = err.Error()
		e.backoff = nextBackoff(e.backoff, r.opts.MaxBackoff)
		e.nextAttempt = time.Now().Add(e.backoff)
		r.opts.Logger.Warn("backend discovery failed",
			slog.String("backend", id),
			slog.Any("error", err),
			slog.String("retryIn", e.backoff.String()))
		return
	}
	e.discovery = doc
	e.ready = true
	e.err = ""
	e.lastOK = time.Now()
	e.backoff = r.opts.InitialBackoff
	e.nextAttempt = time.Time{}
}

// Start discovers every backend in the background, then retries the ones that
// failed until they succeed or ctx is cancelled.
//
// It returns immediately: a bounded attempt per backend would otherwise stall
// startup by N*AttemptTimeout whenever a backend is down. Entry still refreshes on
// demand, so the first request never waits on this loop — Start only means a
// backend that is down at startup recovers on its own rather than on a request.
func (r *Registry[D]) Start(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	r.stop = cancel

	go func() {
		r.mu.RLock()
		ids := append([]string(nil), r.order...)
		r.mu.RUnlock()

		for _, id := range ids {
			if ctx.Err() != nil {
				return
			}
			r.refresh(ctx, id)
		}
		if r.allReady() && !r.opts.Dynamic {
			cancel()
			return
		}
		r.retryLoop(ctx)
	}()
}

// Stop ends the background retry loop.
func (r *Registry[D]) Stop() {
	r.stopOnce.Do(func() {
		if r.stop != nil {
			r.stop()
		}
	})
}

func (r *Registry[D]) allReady() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, e := range r.entries {
		if !e.ready {
			return false
		}
	}
	return true
}

// pending returns the not-yet-ready backends due for another attempt, and how long
// to wait before the next one becomes due.
func (r *Registry[D]) pending(now time.Time) (due []string, wait time.Duration) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	wait = r.opts.MaxBackoff
	for _, id := range r.order {
		e := r.entries[id]
		if e.ready {
			continue
		}
		if !e.nextAttempt.After(now) {
			due = append(due, id)
			continue
		}
		if d := e.nextAttempt.Sub(now); d < wait {
			wait = d
		}
	}
	return due, wait
}

func (r *Registry[D]) retryLoop(ctx context.Context) {
	for {
		due, wait := r.pending(time.Now())
		for _, id := range due {
			r.refresh(ctx, id)
		}
		if r.allReady() {
			if !r.opts.Dynamic {
				r.opts.Logger.Info("all backends discovered")
				return
			}
			// Dynamic: idle rather than finish, so a backend added later is picked
			// up by this loop instead of waiting for a request to force a refresh.
			wait = r.opts.MaxBackoff
		}

		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func nextBackoff(current, max time.Duration) time.Duration {
	next := current * 2
	if next > max {
		return max
	}
	return next
}
