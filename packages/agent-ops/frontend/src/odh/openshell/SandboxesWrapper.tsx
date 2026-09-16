import * as React from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Bullseye, Divider, Flex, FlexItem, PageSection, Spinner } from '@patternfly/react-core';
import { SandboxListPage } from 'openshell-dashboard/pages';
import GatewayHeader from './GatewayHeader';
import { OpenShellConnectGate } from './OpenShellConnection';
import OpenShellProviders from './OpenShellProviders';
import WorkspaceSelector from './WorkspaceSelector';
import { useSelectedWorkspace } from './WorkspaceContext';
import { DEPLOYMENTS_PATH, openShellSandboxPath } from './gatewayRoutes';

// A gateway's page is a workspace-scoped sandbox view. Workspace is a scope
// selector in the table toolbar, not a destination with its own title, status,
// or resource tabs.
const WorkspaceLandingContent: React.FC<{ gatewayId: string }> = ({ gatewayId }) => {
  const navigate = useNavigate();
  const { workspace, isLoading } = useSelectedWorkspace();

  if (isLoading) {
    return (
      <Bullseye>
        <Spinner aria-label="Loading workspaces" />
      </Bullseye>
    );
  }

  return (
    <SandboxListPage
      workspace={workspace}
      createActionPosition="end"
      compactToolbar
      toolbarStart={
        <Flex alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <WorkspaceSelector />
          </FlexItem>
        </Flex>
      }
      // A workspace name is only unique inside its gateway, so every sandbox
      // link carries the gateway that owns it.
      onSelect={(name) => navigate(openShellSandboxPath(gatewayId, workspace, name))}
      onViewSandbox={(name, tab) => navigate(openShellSandboxPath(gatewayId, workspace, name, tab))}
    />
  );
};

const SandboxesWrapper: React.FC = () => {
  const { gatewayId } = useParams<{ gatewayId: string }>();

  if (!gatewayId) {
    return <Navigate to={DEPLOYMENTS_PATH} replace />;
  }

  return (
    <OpenShellProviders gatewayId={gatewayId} requireConnection={false}>
      <GatewayHeader gatewayId={gatewayId} />
      <OpenShellConnectGate>
        <PageSection hasBodyWrapper={false} className="pf-v6-u-pt-0">
          <Divider />
          <WorkspaceLandingContent gatewayId={gatewayId} />
        </PageSection>
      </OpenShellConnectGate>
    </OpenShellProviders>
  );
};

export default SandboxesWrapper;
