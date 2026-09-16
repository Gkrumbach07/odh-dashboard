package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/opendatahub-io/mod-arch-library/bff/internal/config"
	k8s "github.com/opendatahub-io/mod-arch-library/bff/internal/integrations/kubernetes"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func testAppLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
}

func TestNewApp_OpenAPIHandlerFailureNonFatal(t *testing.T) {
	originalWd, err := os.Getwd()
	require.NoError(t, err)

	tempDir := t.TempDir()
	require.NoError(t, os.Chdir(tempDir))
	t.Cleanup(func() {
		assert.NoError(t, os.Chdir(originalWd))
	})

	app, err := NewApp(config.EnvConfig{
		AuthMethod:      config.AuthMethodDisabled,
		StaticAssetsDir: t.TempDir(),
	}, testAppLogger())
	require.NoError(t, err)
	require.NotNil(t, app)
	assert.Nil(t, app.openAPI)
}

func TestInjectRequestIdentity_UnauthorizedWithoutToken(t *testing.T) {
	app := &App{
		config: config.EnvConfig{
			AuthMethod:      config.AuthMethodUser,
			AuthTokenHeader: "Authorization",
			AuthTokenPrefix: "Bearer ",
		},
		logger:                  testAppLogger(),
		kubernetesClientFactory: k8s.NewTokenClientFactory(testAppLogger(), config.EnvConfig{AuthTokenHeader: "Authorization", AuthTokenPrefix: "Bearer "}),
	}

	called := false
	handler := app.InjectRequestIdentity(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
	}))

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, NamespacePath, nil)
	handler.ServeHTTP(rr, req)

	assert.Equal(t, http.StatusUnauthorized, rr.Code)
	assert.False(t, called)
}
