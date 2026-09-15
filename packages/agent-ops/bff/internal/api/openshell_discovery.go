package api

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime"

	"github.com/opendatahub-io/mod-arch-library/bff/internal/config"
)

// Where the OpenShell fleet's membership and OIDC parameters come from.
//
// Two sources, in precedence order:
//
//	1. OPENSHELL_GATEWAYS — an explicit JSON array. Wins outright.
//	2. the cluster        — Services labelled as OpenShell gateways.
//
// Cluster discovery exists to close a drift hole. A gateway rejects a token whose
// issuer or audience does not match what the gateway itself was started with, and
// when those are configured by hand in RHOAI they are a hand-kept copy of the
// gateway's own Helm values. The copy is never validated against the original, so
// drift surfaces only as a refusal several hops away, with no useful diagnostic
// anywhere earlier. Reading issuer and audience out of the gateway's own ConfigMap
// makes them unable to disagree, because there is no longer a second copy.
//
// clientId is deliberately NOT discovered, and this is a property of OpenShell
// rather than a gap here: the gateway has no notion of a browser OIDC client.
// Its [openshell.gateway.oidc] block carries issuer and audience only — the
// client id belongs to whoever runs the browser flow, so it is dashboard-side
// config and arrives as an annotation. It cannot drift against the gateway for
// the same reason: the gateway never sees it.
//
// The k8s half of this (list Services by label, read a port by name) is the piece
// MaaS would reuse; the ConfigMap parsing below is OpenShell-specific.

const (
	// DefaultGatewayLabelSelector matches what the OpenShell Helm chart puts on
	// its Service via the chart's own selectorLabels: app.kubernetes.io/name is
	// the chart name. Narrow it with OPENSHELL_GATEWAY_SELECTOR when a cluster
	// runs something else that answers to the same label.
	DefaultGatewayLabelSelector = "app.kubernetes.io/name=openshell"

	// gatewayGRPCPortName is the chart's name for the gateway's gRPC port. Reading
	// the port by name rather than assuming a number means a gateway installed on a
	// non-default port is still found.
	gatewayGRPCPortName = "grpc"

	// gatewayConfigMapSuffix is the chart's convention: the gateway's config lives
	// in a ConfigMap named after the release with "-config" appended.
	gatewayConfigMapSuffix = "-config"

	// gatewayConfigKey is the key in that ConfigMap holding the gateway's TOML.
	gatewayConfigKey = "gateway.toml"

	// oidcSection is the TOML table the issuer and audience live in.
	oidcSection = "[openshell.gateway.oidc]"
)

// Annotations on the gateway Service carry what the cluster cannot infer. They
// are set next to the install — by the OpenShell operator, or by an admin — so
// the dashboard needs no per-gateway configuration of its own.
const (
	annotationPrefix = "openshell.opendatahub.io/"

	// AnnotationID overrides the derived gateway id. Use it only to preserve an id
	// that is already in use: the id is a URL path segment and keys the browser's
	// stored OIDC session, so changing it logs everyone out of that gateway.
	AnnotationID = annotationPrefix + "id"
	// AnnotationDisplayName is what the gateway switcher shows.
	AnnotationDisplayName = annotationPrefix + "display-name"
	// AnnotationConsoleURL links out to this install's standalone console for
	// capabilities the embedding cannot carry, such as the terminal.
	AnnotationConsoleURL = annotationPrefix + "console-url"
	// AnnotationClientID is the browser's OIDC public client for this gateway.
	// Required: the gateway itself does not know it.
	AnnotationClientID = annotationPrefix + "client-id"
	// AnnotationScope overrides the OIDC scopes requested by the browser.
	AnnotationScope = annotationPrefix + "scope"
	// AnnotationIssuer and AnnotationAudience override what the gateway's own
	// ConfigMap says. Overriding them re-opens the drift hole this discovery
	// closes, so they exist for the case the ConfigMap is unreadable, not as the
	// normal way to configure a gateway.
	AnnotationIssuer   = annotationPrefix + "issuer"
	AnnotationAudience = annotationPrefix + "audience"
	// AnnotationConfigMap names the ConfigMap holding gateway.toml when it is not
	// at the chart's default name.
	AnnotationConfigMap = annotationPrefix + "config-map"
	// AnnotationIgnore excludes a matching Service from the fleet.
	AnnotationIgnore = annotationPrefix + "ignore"
)

// GatewaySource yields the gateways that should currently be in the fleet.
//
// Returning an error means "I could not tell" — the caller keeps the fleet it
// already has rather than tearing it down. Returning an empty slice with no error
// means "there are genuinely none", which does empty the fleet.
type GatewaySource interface {
	Gateways(ctx context.Context) ([]Gateway, error)
	// Describe names the source for logs and for the error a misconfigured fleet
	// reports, so an empty fleet says where it looked.
	Describe() string
}

// StaticGatewaySource serves a fixed list parsed from OPENSHELL_GATEWAYS.
type StaticGatewaySource struct {
	gateways []Gateway
}

// NewStaticGatewaySource parses the OPENSHELL_GATEWAYS JSON array.
func NewStaticGatewaySource(raw string) (*StaticGatewaySource, error) {
	gateways, err := ParseGateways(raw)
	if err != nil {
		return nil, err
	}
	return &StaticGatewaySource{gateways: gateways}, nil
}

func (s *StaticGatewaySource) Gateways(context.Context) ([]Gateway, error) {
	return append([]Gateway(nil), s.gateways...), nil
}

func (s *StaticGatewaySource) Describe() string {
	return fmt.Sprintf("OPENSHELL_GATEWAYS (%d configured)", len(s.gateways))
}

// ClusterGatewaySource finds gateways by asking the cluster.
type ClusterGatewaySource struct {
	client kubernetes.Interface
	logger *slog.Logger

	// Selector is the label selector matching gateway Services.
	Selector string
	// Namespaces bounds the search. Empty searches all namespaces, which needs a
	// cluster-scoped list; naming them keeps the BFF's RBAC namespaced.
	Namespaces []string
	// DefaultClientID and DefaultScope apply to a gateway whose Service does not
	// annotate its own. A single-IdP cluster can then set them once for the
	// dashboard rather than on every gateway.
	DefaultClientID string
	DefaultScope    string
}

// NewClusterGatewaySource builds a source over an already-authenticated client.
// The client must carry the BFF's own credentials, not a caller's: discovery runs
// in the background with no request in flight.
func NewClusterGatewaySource(client kubernetes.Interface, logger *slog.Logger) *ClusterGatewaySource {
	return &ClusterGatewaySource{
		client:   client,
		logger:   logger,
		Selector: DefaultGatewayLabelSelector,
	}
}

func (s *ClusterGatewaySource) Describe() string {
	scope := "all namespaces"
	if len(s.Namespaces) > 0 {
		scope = "namespaces " + strings.Join(s.Namespaces, ",")
	}
	return fmt.Sprintf("cluster Services matching %q in %s", s.Selector, scope)
}

// Gateways lists gateway Services and resolves each one's connection and OIDC
// details.
//
// A gateway that cannot be fully resolved is still returned, carrying whatever
// was resolvable. Dropping it would make a gateway with (say) an unreadable
// ConfigMap vanish from the switcher with no explanation; included, it reaches
// the frontend as a listed-but-not-connectable entry that says why.
func (s *ClusterGatewaySource) Gateways(ctx context.Context) ([]Gateway, error) {
	namespaces := s.Namespaces
	if len(namespaces) == 0 {
		namespaces = []string{metav1.NamespaceAll}
	}

	var services []corev1.Service
	for _, ns := range namespaces {
		list, err := s.client.CoreV1().Services(ns).List(ctx, metav1.ListOptions{LabelSelector: s.Selector})
		if err != nil {
			return nil, fmt.Errorf("list gateway Services in %q: %w", nsLabel(ns), err)
		}
		services = append(services, list.Items...)
	}

	// Sort so the gateway switcher's order is stable across discovery runs rather
	// than following whatever order the API server happened to return.
	sort.Slice(services, func(i, j int) bool {
		if services[i].Namespace != services[j].Namespace {
			return services[i].Namespace < services[j].Namespace
		}
		return services[i].Name < services[j].Name
	})

	gateways := make([]Gateway, 0, len(services))
	seen := make(map[string]string, len(services))
	for i := range services {
		svc := &services[i]
		if strings.EqualFold(strings.TrimSpace(svc.Annotations[AnnotationIgnore]), "true") {
			continue
		}

		g, err := s.gatewayFrom(ctx, svc)
		if err != nil {
			s.logger.Warn("skipping OpenShell gateway Service",
				slog.String("namespace", svc.Namespace),
				slog.String("service", svc.Name),
				slog.Any("error", err))
			continue
		}

		// Two Services claiming one id would silently shadow each other, and the
		// loser would be missing from the switcher with no explanation.
		if prior, clash := seen[g.ID]; clash {
			s.logger.Error("duplicate OpenShell gateway id; ignoring the later Service",
				slog.String("id", g.ID),
				slog.String("kept", prior),
				slog.String("ignored", svc.Namespace+"/"+svc.Name))
			continue
		}
		seen[g.ID] = svc.Namespace + "/" + svc.Name
		gateways = append(gateways, g)
	}

	return gateways, nil
}

func nsLabel(ns string) string {
	if ns == metav1.NamespaceAll {
		return "all namespaces"
	}
	return ns
}

// gatewayFrom turns one Service into a Gateway.
func (s *ClusterGatewaySource) gatewayFrom(ctx context.Context, svc *corev1.Service) (Gateway, error) {
	port, err := grpcPort(svc)
	if err != nil {
		return Gateway{}, err
	}

	g := Gateway{
		ID:         gatewayID(svc),
		Name:       annotation(svc, AnnotationDisplayName),
		GatewayURL: fmt.Sprintf("%s.%s.svc.cluster.local:%d", svc.Name, svc.Namespace, port),
		ConsoleURL: annotation(svc, AnnotationConsoleURL),
		ClientID:   annotation(svc, AnnotationClientID),
		Scope:      annotation(svc, AnnotationScope),
		Issuer:     annotation(svc, AnnotationIssuer),
		Audience:   annotation(svc, AnnotationAudience),
	}
	if g.Name == "" {
		g.Name = g.ID
	}
	if g.ClientID == "" {
		g.ClientID = s.DefaultClientID
	}
	if g.Scope == "" {
		g.Scope = s.DefaultScope
	}

	// Only read the ConfigMap when an annotation has not already answered, so an
	// explicit override costs no API call.
	if g.Issuer == "" || g.Audience == "" {
		issuer, audience, cmErr := s.oidcFromConfigMap(ctx, svc)
		if cmErr != nil {
			// Not fatal: the gateway is still listed, and viewOf reports it as not
			// connectable with the reason attached.
			s.logger.Warn("could not read OIDC settings from the gateway's ConfigMap",
				slog.String("gateway", g.ID),
				slog.Any("error", cmErr))
		}
		if g.Issuer == "" {
			g.Issuer = issuer
		}
		if g.Audience == "" {
			g.Audience = audience
		}
	}

	return g, nil
}

// gatewayID derives the fleet id for a Service.
//
// The id is a URL path segment and keys the browser's per-gateway OIDC session
// storage, so it must depend only on that gateway's own coordinates. Deriving it
// from anything global — "use the bare name when it happens to be unique" —
// would rename an existing gateway the moment a second one appeared, logging its
// users out. namespace/name is unique by construction and never moves.
func gatewayID(svc *corev1.Service) string {
	if explicit := annotation(svc, AnnotationID); explicit != "" {
		return explicit
	}
	if svc.Namespace == svc.Name {
		return svc.Name
	}
	return svc.Namespace + "-" + svc.Name
}

// grpcPort finds the gateway's gRPC port, by name, then by appProtocol, then by
// being the only port there is.
func grpcPort(svc *corev1.Service) (int32, error) {
	for _, p := range svc.Spec.Ports {
		if p.Name == gatewayGRPCPortName {
			return p.Port, nil
		}
	}
	for _, p := range svc.Spec.Ports {
		if p.AppProtocol != nil && strings.EqualFold(*p.AppProtocol, gatewayGRPCPortName) {
			return p.Port, nil
		}
	}
	if len(svc.Spec.Ports) == 1 {
		return svc.Spec.Ports[0].Port, nil
	}
	return 0, fmt.Errorf("no port named %q and %d ports to choose from", gatewayGRPCPortName, len(svc.Spec.Ports))
}

// oidcFromConfigMap reads issuer and audience out of the gateway's own config.
func (s *ClusterGatewaySource) oidcFromConfigMap(ctx context.Context, svc *corev1.Service) (issuer, audience string, err error) {
	name := annotation(svc, AnnotationConfigMap)
	if name == "" {
		name = svc.Name + gatewayConfigMapSuffix
	}

	cm, err := s.client.CoreV1().ConfigMaps(svc.Namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", "", fmt.Errorf("get ConfigMap %s/%s: %w", svc.Namespace, name, err)
	}

	toml, ok := cm.Data[gatewayConfigKey]
	if !ok {
		return "", "", fmt.Errorf("ConfigMap %s/%s has no %q key", svc.Namespace, name, gatewayConfigKey)
	}

	oidc := parseGatewayOIDC(toml)
	if oidc["issuer"] == "" {
		// A gateway with no issuer is running without OIDC. That is a valid
		// standalone configuration, but it cannot be embedded: the browser has no
		// provider to sign in to.
		return "", "", fmt.Errorf("ConfigMap %s/%s declares no OIDC issuer; the gateway is not running OIDC", svc.Namespace, name)
	}
	return oidc["issuer"], oidc["audience"], nil
}

// parseGatewayOIDC pulls the key/value pairs out of the [openshell.gateway.oidc]
// table of a gateway.toml.
//
// This reads one flat table of quoted scalars, which is all that table contains —
// it is not a TOML parser, and deliberately not, to avoid taking a TOML
// dependency for six string fields. Anything it does not understand it skips, so
// a gateway.toml that grows new syntax degrades to "issuer not found" (the
// gateway is listed as not connectable) rather than to a wrong issuer.
func parseGatewayOIDC(toml string) map[string]string {
	out := map[string]string{}
	inSection := false

	for _, line := range strings.Split(toml, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			inSection = line == oidcSection
			continue
		}
		if !inSection {
			continue
		}

		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		// Only quoted scalars are taken. Bare numbers (jwks_ttl_secs) and arrays
		// are not values this needs, and guessing at them would be how a wrong
		// answer gets in.
		if len(value) < 2 || !strings.HasPrefix(value, `"`) || !strings.HasSuffix(value, `"`) {
			continue
		}
		out[strings.TrimSpace(key)] = value[1 : len(value)-1]
	}
	return out
}

func annotation(svc *corev1.Service, key string) string {
	return strings.TrimSpace(svc.Annotations[key])
}

// newOpenShellSource picks the gateway source for this deployment, or nil when
// OpenShell is not configured at all.
//
// An explicit OPENSHELL_GATEWAYS wins over discovery. That ordering is the point:
// discovery is what production should use, but a developer pointing at a gateway
// on a laptop, or an operator pinning an install the label selector does not
// match, needs a way to say so that discovery cannot override.
func newOpenShellSource(cfg config.EnvConfig, logger *slog.Logger) (GatewaySource, error) {
	if strings.TrimSpace(cfg.OpenShellGateways) != "" {
		if cfg.OpenShellDiscovery {
			logger.Warn("both OPENSHELL_GATEWAYS and OpenShell discovery are set; the explicit list wins")
		}
		return NewStaticGatewaySource(cfg.OpenShellGateways)
	}
	if !cfg.OpenShellDiscovery {
		return nil, nil
	}

	// Discovery runs in the background with no request in flight, so it uses the
	// dashboard's own credentials. This is emphatically not a way to read a
	// gateway on a caller's behalf: nothing user-supplied reaches it, and what it
	// returns is deployment topology rather than anyone's data.
	restCfg, err := ctrl.GetConfig()
	if err != nil {
		return nil, fmt.Errorf("load credentials for gateway discovery: %w", err)
	}
	client, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return nil, fmt.Errorf("build client for gateway discovery: %w", err)
	}

	source := NewClusterGatewaySource(client, logger)
	if sel := strings.TrimSpace(cfg.OpenShellGatewaySelector); sel != "" {
		source.Selector = sel
	}
	source.Namespaces = cfg.OpenShellGatewayNamespaces
	source.DefaultClientID = strings.TrimSpace(cfg.OpenShellClientID)
	source.DefaultScope = strings.TrimSpace(cfg.OpenShellScope)
	return source, nil
}
