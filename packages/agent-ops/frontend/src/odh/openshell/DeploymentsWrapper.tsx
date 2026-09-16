import * as React from 'react';
import { Route, Routes } from 'react-router-dom';
import NotFound from '@odh-dashboard/ui-core/components/NotFound';
import OpenShellProviders from './OpenShellProviders';
import ProviderLandingPage from './ProviderLandingPage';
import SandboxDetailWrapper from './SandboxDetailWrapper';
import SandboxesWrapper from './SandboxesWrapper';

const DeploymentsWrapper: React.FC = () => (
  <Routes>
    <Route
      index
      element={
        <OpenShellProviders requireConnection={false}>
          <ProviderLandingPage />
        </OpenShellProviders>
      }
    />
    <Route path="providers/openshell" element={<SandboxesWrapper />} />
    <Route
      path="providers/openshell/workspaces/:workspace/sandboxes/:sandbox/*"
      element={<SandboxDetailWrapper />}
    />
    <Route path="*" element={<NotFound />} />
  </Routes>
);

export default DeploymentsWrapper;
