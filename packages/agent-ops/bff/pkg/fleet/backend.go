// Package fleet fronts a set of externally-deployed backend services from a single
// dashboard module BFF.
//
// It exists because the module-federation proxy maps one path to one service, which
// is enough when a module fronts a single external gateway but not when it fronts
// several. Everything here is deliberately free of any consumer's domain types:
// agent-ops uses it to route to OpenShell installs, and it is written so MaaS (which
// today fronts one gateway with runtime discovery, and gains the same problem the
// moment it fronts several) can lift the package without modification.
//
// To extract: move this directory to a shared module and update the import path.
// It depends only on the standard library.
package fleet

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// idPattern constrains an ID to a DNS-1123 label. An ID is both a URL path segment
// and a map key, so it is validated when the fleet is built rather than at use.
var idPattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// Backend is one externally-deployed service this module fronts.
type Backend struct {
	// ID is the stable path segment: /{prefix}/{id}/...
	ID string
	// Name is what a switcher shows.
	Name string
	// URL is the in-cluster base URL to proxy to.
	URL string
	// LinkURL is an optional human-facing URL for this backend (a standalone
	// console, say). Never proxied through — only surfaced for linking out.
	LinkURL string
}

// backendJSON is the canonical wire shape accepted by ParseBackends. The aliases
// let a consumer keep a domain-flavoured config key without a bespoke parser.
type backendJSON struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	BFFURL     string `json:"bffUrl"`
	LinkURL    string `json:"linkUrl"`
	ConsoleURL string `json:"consoleUrl"`
}

// ParseBackends reads a JSON array of backends. An empty string yields none, which
// callers should treat as "this feature is not configured" rather than an error.
func ParseBackends(raw string) ([]Backend, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}

	var decoded []backendJSON
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, fmt.Errorf("not a valid JSON array of backends: %w", err)
	}

	backends := make([]Backend, 0, len(decoded))
	for _, d := range decoded {
		url := d.URL
		if url == "" {
			url = d.BFFURL
		}
		link := d.LinkURL
		if link == "" {
			link = d.ConsoleURL
		}
		backends = append(backends, Backend{
			ID:      strings.TrimSpace(d.ID),
			Name:    strings.TrimSpace(d.Name),
			URL:     strings.TrimRight(strings.TrimSpace(url), "/"),
			LinkURL: strings.TrimRight(strings.TrimSpace(link), "/"),
		})
	}

	if err := Validate(backends); err != nil {
		return nil, err
	}
	return backends, nil
}

// Validate checks IDs and URLs and defaults each Name to its ID. Consumers that
// parse their own config shape should call this before building a Registry.
func Validate(backends []Backend) error {
	seen := make(map[string]struct{}, len(backends))
	for i := range backends {
		b := &backends[i]
		if !idPattern.MatchString(b.ID) {
			return fmt.Errorf("backend id %q is not a DNS-1123 label", b.ID)
		}
		if _, dup := seen[b.ID]; dup {
			return fmt.Errorf("duplicate backend id %q", b.ID)
		}
		seen[b.ID] = struct{}{}

		if b.URL == "" {
			return fmt.Errorf("backend %q has no url", b.ID)
		}
		if !strings.HasPrefix(b.URL, "http://") && !strings.HasPrefix(b.URL, "https://") {
			return fmt.Errorf("backend %q url must be http(s): %q", b.ID, b.URL)
		}
		if b.Name == "" {
			b.Name = b.ID
		}
	}
	return nil
}
