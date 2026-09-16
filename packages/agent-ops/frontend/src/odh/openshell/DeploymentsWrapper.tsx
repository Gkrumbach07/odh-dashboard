import * as React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import NotFound from '@odh-dashboard/ui-core/components/NotFound';
import GatewayLandingPage from './GatewayLandingPage';
import { GatewayRegistryProvider } from './OpenShellConnection';
import SandboxDetailWrapper from './SandboxDetailWrapper';
import SandboxesWrapper from './SandboxesWrapper';
import { DEPLOYMENTS_PATH } from './gatewayRoutes';

/**
 * The agent gateway area.
 *
 * Discovery is fetched once here, above <Routes>, rather than by each route
 * element: list → gateway → sandbox detail is one visit to one registry, and
 * mounting the provider per route made every navigation refetch it and flash a
 * full-page spinner. Hoisting it also means the poll keeps running while the
 * user moves around, which is what makes a gateway appearing or vanishing
 * visible without a reload.
 */
const DeploymentsWrapper: React.FC = () => (
  <GatewayRegistryProvider>
    <Routes>
      <Route index element={<GatewayLandingPage />} />
      <Route path="gateways/:gatewayId" element={<SandboxesWrapper />} />
      <Route
        path="gateways/:gatewayId/workspaces/:workspace/sandboxes/:sandbox/*"
        element={<SandboxDetailWrapper />}
      />
      {/*
        Pre-multi-gateway bookmarks. Those URLs named a provider, never a
        gateway, so there is nothing to carry across — they land on the list
        rather than guessing an install. Short-lived: one release, then delete.
      */}
      <Route path="providers/openshell/*" element={<Navigate to={DEPLOYMENTS_PATH} replace />} />
      <Route path="providers/native/*" element={<Navigate to={DEPLOYMENTS_PATH} replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </GatewayRegistryProvider>
);

export default DeploymentsWrapper;
