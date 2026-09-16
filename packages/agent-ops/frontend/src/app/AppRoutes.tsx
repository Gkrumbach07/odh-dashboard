import * as React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import NotFound from './components/NotFound';
import { agentDeploymentsPath, oidcCallbackPath, oidcSilentCallbackPath } from './utilities/routes';

const DeploymentsWrapper = React.lazy(() => import('../odh/openshell/DeploymentsWrapper'));
const OpenShellOidcCallback = React.lazy(() => import('../odh/openshell/OpenShellOidcCallback'));

/**
 * The standalone router.
 *
 * Deliberately mirrors what `src/odh/extensions.ts` contributes to the dashboard
 * so a developer gets the same surface here without running the host: the
 * Deployments subtree (the `app.tab-route/tab` extension) plus the two OpenShell
 * OIDC callbacks (the `app.route` extensions). The callbacks are not optional
 * extras — `openShellAuth` stamps them into every gateway's `redirect_uri`
 * regardless of deployment mode, so without them "Connect" leaves the IdP to
 * redirect into this router's catch-all and the sign-in dies on a 404 page.
 */
const AppRoutes: React.FC = () => (
  <Routes>
    <Route path="/" element={<Navigate to={agentDeploymentsPath} replace />} />
    <Route
      path={`${agentDeploymentsPath}/*`}
      element={
        <React.Suspense fallback={null}>
          <DeploymentsWrapper />
        </React.Suspense>
      }
    />
    <Route
      path={oidcCallbackPath}
      element={
        <React.Suspense fallback={null}>
          <OpenShellOidcCallback />
        </React.Suspense>
      }
    />
    <Route
      path={oidcSilentCallbackPath}
      element={
        <React.Suspense fallback={null}>
          <OpenShellOidcCallback />
        </React.Suspense>
      }
    />
    <Route path="*" element={<NotFound />} />
  </Routes>
);

export default AppRoutes;
