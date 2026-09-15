package api

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// gatewayTOML is the shape the OpenShell chart actually renders, trimmed to the
// sections that matter here. The [openshell.gateway] table deliberately carries
// its own `bind_address` so the test proves the parser is scoped to the oidc
// table rather than scanning the whole file for keys.
const gatewayTOML = `
[openshell]
version = 1

[openshell.gateway]
bind_address          = "0.0.0.0:8080"
log_level             = "info"
audience              = "WRONG-not-the-oidc-table"

[openshell.gateway.oidc]
issuer        = "https://dex.apps.example.com"
audience      = "openshell-cli"
jwks_ttl_secs = 3600
roles_claim   = "realm_access.roles"

[openshell.drivers.kubernetes]
service_account_name = "openshell-sandbox"
`

func gatewayService(ns, name string, annotations map[string]string) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   ns,
			Labels:      map[string]string{"app.kubernetes.io/name": "openshell"},
			Annotations: annotations,
		},
		Spec: corev1.ServiceSpec{
			Ports: []corev1.ServicePort{
				{Name: "metrics", Port: 9090},
				{Name: "grpc", Port: 8080},
			},
		},
	}
}

func gatewayConfigMap(ns, name, toml string) *corev1.ConfigMap {
	return &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Data:       map[string]string{"gateway.toml": toml},
	}
}

func TestParseGatewayOIDC(t *testing.T) {
	t.Run("reads only the oidc table", func(t *testing.T) {
		got := parseGatewayOIDC(gatewayTOML)
		assert.Equal(t, "https://dex.apps.example.com", got["issuer"])
		// The [openshell.gateway] table also has an `audience` key. Picking that
		// one up would hand the browser an audience the gateway does not accept,
		// which is the exact silent refusal this discovery exists to prevent.
		assert.Equal(t, "openshell-cli", got["audience"])
		assert.Equal(t, "realm_access.roles", got["roles_claim"])
	})

	t.Run("skips values it cannot read rather than guessing", func(t *testing.T) {
		got := parseGatewayOIDC(gatewayTOML)
		// jwks_ttl_secs is a bare integer. Nothing here needs it, and a parser
		// that half-understood it would be a parser that can be wrong.
		assert.NotContains(t, got, "jwks_ttl_secs")
	})

	t.Run("no oidc table yields nothing", func(t *testing.T) {
		assert.Empty(t, parseGatewayOIDC("[openshell.gateway]\nissuer = \"https://nope\"\n"))
	})
}

func TestClusterGatewaySourceDiscoversOIDCFromTheGatewaysOwnConfig(t *testing.T) {
	client := fake.NewSimpleClientset(
		gatewayService("openshell", "openshell", map[string]string{
			AnnotationClientID:    "openshell-dashboard",
			AnnotationDisplayName: "Production",
			AnnotationConsoleURL:  "https://openshell.apps.example.com",
		}),
		gatewayConfigMap("openshell", "openshell-config", gatewayTOML),
	)

	source := NewClusterGatewaySource(client, discardLogger())
	gateways, err := source.Gateways(context.Background())
	require.NoError(t, err)
	require.Len(t, gateways, 1)

	g := gateways[0]
	assert.Equal(t, "openshell", g.ID)
	assert.Equal(t, "Production", g.Name)
	// Port taken by name, not by position: "metrics" is listed first.
	assert.Equal(t, "openshell.openshell.svc.cluster.local:8080", g.GatewayURL)
	assert.Equal(t, "https://openshell.apps.example.com", g.ConsoleURL)

	// The whole point: these came from the gateway, not from dashboard config.
	assert.Equal(t, "https://dex.apps.example.com", g.Issuer)
	assert.Equal(t, "openshell-cli", g.Audience)
	// And this one could not have: the gateway has no notion of a browser client.
	assert.Equal(t, "openshell-dashboard", g.ClientID)
}

func TestClusterGatewaySourceKeepsAGatewayItCannotFullyResolve(t *testing.T) {
	// No ConfigMap: the gateway is real and running, but its OIDC settings are
	// unreadable. Dropping it would make it vanish from the switcher with no
	// explanation; listing it lets viewOf say what is missing.
	client := fake.NewSimpleClientset(gatewayService("openshell", "openshell", nil))

	gateways, err := NewClusterGatewaySource(client, discardLogger()).Gateways(context.Background())
	require.NoError(t, err)
	require.Len(t, gateways, 1)
	assert.Empty(t, gateways[0].Issuer)
	assert.Equal(t, "openshell.openshell.svc.cluster.local:8080", gateways[0].GatewayURL)
}

func TestClusterGatewaySourceRespectsAnnotationOverrides(t *testing.T) {
	client := fake.NewSimpleClientset(
		gatewayService("team-a", "openshell", map[string]string{
			AnnotationIssuer:    "https://override.example",
			AnnotationAudience:  "override-audience",
			AnnotationConfigMap: "does-not-exist",
		}),
	)

	gateways, err := NewClusterGatewaySource(client, discardLogger()).Gateways(context.Background())
	require.NoError(t, err)
	require.Len(t, gateways, 1)
	// The annotations answered, so the missing ConfigMap was never consulted.
	assert.Equal(t, "https://override.example", gateways[0].Issuer)
	assert.Equal(t, "override-audience", gateways[0].Audience)
}

func TestClusterGatewaySourceSkipsIgnoredServices(t *testing.T) {
	client := fake.NewSimpleClientset(
		gatewayService("openshell", "openshell", nil),
		gatewayService("other", "openshell", map[string]string{AnnotationIgnore: "true"}),
	)

	gateways, err := NewClusterGatewaySource(client, discardLogger()).Gateways(context.Background())
	require.NoError(t, err)
	require.Len(t, gateways, 1)
	assert.Equal(t, "openshell", gateways[0].ID)
}

// A gateway id is a URL path segment and keys the browser's stored OIDC session
// for that gateway. If adding a second gateway renamed the first, everyone signed
// in to it would be silently signed out — so an id must depend only on its own
// Service's coordinates, never on what else happens to exist.
func TestGatewayIDsAreStableWhenAnotherGatewayAppears(t *testing.T) {
	alone := fake.NewSimpleClientset(gatewayService("openshell", "openshell", nil))
	first, err := NewClusterGatewaySource(alone, discardLogger()).Gateways(context.Background())
	require.NoError(t, err)
	require.Len(t, first, 1)

	crowded := fake.NewSimpleClientset(
		gatewayService("openshell", "openshell", nil),
		gatewayService("team-b", "openshell", nil),
	)
	second, err := NewClusterGatewaySource(crowded, discardLogger()).Gateways(context.Background())
	require.NoError(t, err)
	require.Len(t, second, 2)

	ids := []string{second[0].ID, second[1].ID}
	assert.Contains(t, ids, first[0].ID, "the existing gateway's id must not change")
	assert.Contains(t, ids, "team-b-openshell")
}

func TestClusterGatewaySourceOrdersGatewaysStably(t *testing.T) {
	client := fake.NewSimpleClientset(
		gatewayService("zeta", "openshell", nil),
		gatewayService("alpha", "openshell", nil),
	)
	source := NewClusterGatewaySource(client, discardLogger())

	first, err := source.Gateways(context.Background())
	require.NoError(t, err)
	second, err := source.Gateways(context.Background())
	require.NoError(t, err)

	assert.Equal(t, first, second)
	assert.Equal(t, "alpha-openshell", first[0].ID)
}

func TestGRPCPortResolution(t *testing.T) {
	byAppProtocol := "grpc"
	tests := []struct {
		name    string
		ports   []corev1.ServicePort
		want    int32
		wantErr bool
	}{
		{"by name", []corev1.ServicePort{{Name: "metrics", Port: 9090}, {Name: "grpc", Port: 8080}}, 8080, false},
		{"by appProtocol", []corev1.ServicePort{{Name: "api", Port: 7070, AppProtocol: &byAppProtocol}}, 7070, false},
		{"single port", []corev1.ServicePort{{Name: "whatever", Port: 6060}}, 6060, false},
		{"ambiguous", []corev1.ServicePort{{Name: "a", Port: 1}, {Name: "b", Port: 2}}, 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := grpcPort(&corev1.Service{Spec: corev1.ServiceSpec{Ports: tt.ports}})
			if tt.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestClusterGatewaySourceAppliesDefaultClientID(t *testing.T) {
	client := fake.NewSimpleClientset(
		gatewayService("openshell", "openshell", nil),
		gatewayConfigMap("openshell", "openshell-config", gatewayTOML),
	)
	source := NewClusterGatewaySource(client, discardLogger())
	source.DefaultClientID = "rhoai-dashboard"
	source.DefaultScope = "openid profile"

	gateways, err := source.Gateways(context.Background())
	require.NoError(t, err)
	require.Len(t, gateways, 1)
	assert.Equal(t, "rhoai-dashboard", gateways[0].ClientID)
	assert.Equal(t, "openid profile", gateways[0].Scope)
}
