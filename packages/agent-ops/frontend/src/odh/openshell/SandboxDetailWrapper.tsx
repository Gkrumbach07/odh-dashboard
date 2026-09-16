import * as React from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { Breadcrumb, BreadcrumbItem, PageBreadcrumb } from '@patternfly/react-core';
import { SandboxDetailPage } from 'openshell-dashboard/pages';
import { OpenShellConnectGate, useOpenShellConnection } from './OpenShellConnection';
import OpenShellProviders from './OpenShellProviders';
import { DEPLOYMENTS_PATH, gatewayRoute } from './gatewayRoutes';

/**
 * Trail back out of a sandbox. Rendered inside OpenShellProviders so the middle
 * crumb can name the gateway the sandbox actually belongs to; it falls back to
 * the raw id when that gateway has dropped out of discovery, which is still a
 * true and useful thing to show.
 */
const SandboxBreadcrumb: React.FC<{ gatewayId: string; sandbox: string }> = ({
  gatewayId,
  sandbox,
}) => {
  const { gateway } = useOpenShellConnection();

  return (
    <PageBreadcrumb hasBodyWrapper={false}>
      <Breadcrumb>
        <BreadcrumbItem>
          <Link to={DEPLOYMENTS_PATH}>All gateways</Link>
        </BreadcrumbItem>
        <BreadcrumbItem>
          <Link to={gatewayRoute(gatewayId)}>{gateway?.name || gatewayId}</Link>
        </BreadcrumbItem>
        <BreadcrumbItem isActive>{sandbox}</BreadcrumbItem>
      </Breadcrumb>
    </PageBreadcrumb>
  );
};

const SandboxDetailWrapper: React.FC = () => {
  const { gatewayId, workspace, sandbox } = useParams<{
    gatewayId: string;
    workspace: string;
    sandbox: string;
  }>();

  if (!gatewayId || !workspace || !sandbox) {
    return <Navigate to={DEPLOYMENTS_PATH} replace />;
  }

  return (
    <OpenShellProviders gatewayId={gatewayId} requireConnection={false}>
      <SandboxBreadcrumb gatewayId={gatewayId} sandbox={sandbox} />
      <OpenShellConnectGate>
        <SandboxDetailPage workspace={workspace} sandboxName={sandbox} />
      </OpenShellConnectGate>
    </OpenShellProviders>
  );
};

export default SandboxDetailWrapper;
