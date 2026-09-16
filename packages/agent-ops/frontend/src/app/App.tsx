import * as React from 'react';
import '@patternfly/react-core/dist/styles/base.css';
import './app.css';
import { useLocation } from 'react-router-dom';
import {
  Alert,
  Bullseye,
  Button,
  Page,
  PageSection,
  PageSidebar,
  Spinner,
  Stack,
  StackItem,
} from '@patternfly/react-core';
import {
  DeploymentMode,
  logout,
  useModularArchContext,
  useNamespaceSelector,
  useSettings,
} from 'mod-arch-core';
import AppRoutes from '~/app/AppRoutes';
import { AppContext } from '~/app/context/AppContext';
import { oidcCallbackPath, oidcSilentCallbackPath } from '~/app/utilities/routes';

const App: React.FC = () => {
  const {
    configSettings,
    userSettings,
    loaded: configLoaded,
    loadError: configError,
  } = useSettings();

  const { namespacesLoadError, initializationError } = useNamespaceSelector();

  const { config } = useModularArchContext();
  const { deploymentMode } = config;
  const isStandalone = deploymentMode === DeploymentMode.Standalone;

  /**
   * An OpenShell OIDC callback needs nothing this component fetches — it reads
   * the IdP's response out of the URL and hands it to that gateway's own
   * UserManager. Gating it would break the silent renew in particular: it runs
   * in a freshly created hidden iframe, and a spinner or an error page there
   * never posts the response back, so the parent tab's `signinSilent()` sits
   * until its own deadline and a perfectly good session flips to "Sign-in
   * failed" shortly before every token expiry.
   */
  const { pathname } = useLocation();
  const isOidcCallback = pathname === oidcCallbackPath || pathname === oidcSilentCallbackPath;

  const contextValue = React.useMemo(
    () =>
      configSettings && userSettings
        ? {
            config: configSettings!,
            user: userSettings!,
          }
        : null,
    [configSettings, userSettings],
  );

  const sidebar = <PageSidebar isSidebarOpen={false} />;

  /**
   * Listing namespaces needs cluster-wide `list namespaces`, which plenty of
   * users signing into this shell do not have — and nothing this shell renders
   * reads the result. The whole route tree is the agent gateway area, and a
   * gateway is scoped by gateway id and OpenShell workspace, never by platform
   * project (see GatewayHeader's own wording). So a failure here is reported
   * beside the app rather than in place of it: blocking on it turned a
   * permission a developer does not need into a dead shell, which is the one
   * thing a dev-facing standalone build must not do.
   *
   * `initializationError` is the Kubeflow namespace loader's failure and is part
   * of the same story, so it is treated the same way.
   */
  const projectListError = namespacesLoadError ?? initializationError;

  if (isOidcCallback) {
    return <AppRoutes />;
  }

  // We lack the critical data to startup the app. Only the settings/user call
  // qualifies: it is this module's liveness-and-identity probe, so a failure
  // means the BFF is unreachable or the session is bad and nothing below will
  // work either.
  if (configError) {
    return (
      <Page sidebar={sidebar}>
        <PageSection>
          <Stack hasGutter>
            <StackItem>
              <Alert variant="danger" isInline title="General loading error">
                <p>{configError.message || 'Unknown error occurred during startup'}</p>
                <p>Logging out and logging back in may solve the issue</p>
              </Alert>
            </StackItem>
            <StackItem>
              <Button
                variant="secondary"
                onClick={() => logout().then(() => window.location.reload())}
              >
                Logout
              </Button>
            </StackItem>
          </Stack>
        </PageSection>
      </Page>
    );
  }

  // Waiting on the API to finish
  const loading = !configLoaded || !userSettings || !configSettings || !contextValue;

  return loading ? (
    <Bullseye>
      <Spinner />
    </Bullseye>
  ) : (
    <AppContext.Provider value={contextValue}>
      <Page mainContainerId="primary-app-container" isManagedSidebar={isStandalone}>
        {projectListError ? (
          <PageSection hasBodyWrapper={false}>
            <Alert
              variant="warning"
              isInline
              title="Projects could not be listed"
              data-testid="project-list-warning"
            >
              <p>{projectListError.message || 'Unknown error listing projects'}</p>
              <p>
                Agent gateways are scoped by workspace rather than by project, so gateway pages are
                unaffected.
              </p>
            </Alert>
          </PageSection>
        ) : null}
        <AppRoutes />
      </Page>
    </AppContext.Provider>
  );
};

export default App;
