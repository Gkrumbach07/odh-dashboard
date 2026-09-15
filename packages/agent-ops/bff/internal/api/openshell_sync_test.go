package api

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeSource stands in for cluster discovery so these tests exercise the fleet's
// reaction to a changing answer without needing a cluster.
type fakeSource struct {
	gateways []Gateway
	err      error
	calls    int
}

func (f *fakeSource) Gateways(context.Context) ([]Gateway, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return append([]Gateway(nil), f.gateways...), nil
}

func (f *fakeSource) Describe() string { return "fake source" }

func gateway(id, issuer string) Gateway {
	return Gateway{
		ID:         id,
		Name:       id,
		GatewayURL: id + ".openshell.svc.cluster.local:8080",
		Issuer:     issuer,
		ClientID:   "openshell-dashboard",
		Audience:   "openshell-cli",
	}
}

func newTestFleet(t *testing.T, source GatewaySource) *OpenShellFleet {
	t.Helper()
	f, err := NewOpenShellFleet(context.Background(), source, nil, discardLogger())
	require.NoError(t, err)
	t.Cleanup(f.Close)
	return f
}

func TestFleetPopulatesFromItsSource(t *testing.T) {
	f := newTestFleet(t, &fakeSource{gateways: []Gateway{gateway("a", "https://dex.example")}})

	assert.Equal(t, 1, f.Len())
	b, ok := f.Lookup("a")
	require.True(t, ok)
	assert.Equal(t, "a", b.Name)
}

// An empty cluster is a legitimate answer, not a startup failure: the operator
// may simply not have installed a gateway yet, and the resync loop picks one up
// when it appears.
func TestFleetStartsEmptyWithoutError(t *testing.T) {
	f := newTestFleet(t, &fakeSource{})
	assert.Equal(t, 0, f.Len())
	assert.NotNil(t, f.Router(), "the router must exist so a gateway installed later is routable")
}

func TestFleetAddsAndRemovesGatewaysOnResync(t *testing.T) {
	source := &fakeSource{gateways: []Gateway{gateway("a", "https://dex.example")}}
	f := newTestFleet(t, source)

	source.gateways = []Gateway{gateway("a", "https://dex.example"), gateway("b", "https://keycloak.example")}
	require.NoError(t, f.Sync(context.Background()))
	assert.Equal(t, 2, f.Len())

	source.gateways = []Gateway{gateway("b", "https://keycloak.example")}
	require.NoError(t, f.Sync(context.Background()))
	assert.Equal(t, 1, f.Len())
	_, gone := f.Lookup("a")
	assert.False(t, gone, "a gateway removed from the cluster must stop resolving")
}

// The drift fix, end to end: a gateway whose issuer changes must be served by an
// App rebuilt against the new issuer. The App bakes the OIDC config in at
// construction, so keeping the old one would hand the browser an issuer the
// gateway no longer accepts — which is exactly the silent refusal that made
// hand-copied config a problem in the first place.
func TestFleetRebuildsAGatewayWhoseOIDCConfigChanges(t *testing.T) {
	source := &fakeSource{gateways: []Gateway{gateway("a", "https://old-idp.example")}}
	f := newTestFleet(t, source)

	before := f.gatewayFor(t, "a")
	require.Equal(t, "https://old-idp.example", before.Issuer)

	source.gateways = []Gateway{gateway("a", "https://new-idp.example")}
	require.NoError(t, f.Sync(context.Background()))

	after := f.gatewayFor(t, "a")
	assert.Equal(t, "https://new-idp.example", after.Issuer)
	assert.Equal(t, 1, f.Len(), "rebuilding must not duplicate the gateway")
}

// A source that cannot answer means "I could not tell", not "there are none".
// Emptying the fleet on a transient API server error would disconnect every user
// from every working gateway.
func TestFleetKeepsItsGatewaysWhenTheSourceFails(t *testing.T) {
	source := &fakeSource{gateways: []Gateway{gateway("a", "https://dex.example")}}
	f := newTestFleet(t, source)

	source.err = errors.New("apiserver is having a moment")
	err := f.Sync(context.Background())

	require.Error(t, err)
	assert.Equal(t, 1, f.Len(), "a failed resync must leave the fleet untouched")
	_, stillThere := f.Lookup("a")
	assert.True(t, stillThere)
}

func TestFleetRejectsGatewaysWithUnusableIDs(t *testing.T) {
	source := &fakeSource{gateways: []Gateway{gateway("Not A Label", "https://dex.example")}}
	_, err := NewOpenShellFleet(context.Background(), source, nil, discardLogger())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "fake source")
}

// gatewayFor reads back the Gateway the fleet is currently serving for an id.
func (f *OpenShellFleet) gatewayFor(t *testing.T, id string) Gateway {
	t.Helper()
	f.mu.RLock()
	defer f.mu.RUnlock()
	g, ok := f.gateways[id]
	require.True(t, ok, "no gateway %q in the fleet", id)
	return g
}
