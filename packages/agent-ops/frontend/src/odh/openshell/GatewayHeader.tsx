import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Breadcrumb,
  BreadcrumbItem,
  Content,
  Flex,
  FlexItem,
  PageSection,
  Stack,
  StackItem,
} from '@patternfly/react-core';
import {
  GatewaySwitcher,
  OpenShellConnectionChip,
  useGatewayRegistry,
} from './OpenShellConnection';
import { DEPLOYMENTS_PATH, gatewayRoute } from './gatewayRoutes';

type GatewayHeaderProps = {
  /** The gateway this page is scoped to, straight from the :gatewayId segment. */
  gatewayId: string;
};

/**
 * Header for a gateway-scoped page.
 *
 * Reads the gateway out of the registry rather than describing "OpenShell" in
 * the abstract: with several installs discovered on one cluster, the only
 * useful thing a header can say is *which* one you are on and what it is —
 * its id, the identity domain it signs you into, the version it reports, and
 * any non-fatal configuration warning discovery attached to it.
 */
const GatewayHeader: React.FC<GatewayHeaderProps> = ({ gatewayId }) => {
  const navigate = useNavigate();
  const { gateways } = useGatewayRegistry();
  const gateway = React.useMemo(
    () => gateways.find((g) => g.id === gatewayId) ?? null,
    [gateways, gatewayId],
  );

  // The display name comes from an annotation and can be empty, and two
  // gateways may share one, so the id is always shown alongside it.
  const name = gateway?.name || gatewayId;

  return (
    <PageSection hasBodyWrapper={false} className="pf-v6-u-py-md">
      <Stack hasGutter>
        <StackItem>
          <Breadcrumb>
            <BreadcrumbItem>
              <Link to={DEPLOYMENTS_PATH}>All gateways</Link>
            </BreadcrumbItem>
            <BreadcrumbItem isActive>{name}</BreadcrumbItem>
          </Breadcrumb>
        </StackItem>
        <StackItem>
          <Flex
            justifyContent={{ default: 'justifyContentSpaceBetween' }}
            alignItems={{ default: 'alignItemsCenter' }}
            gap={{ default: 'gapLg' }}
          >
            <FlexItem grow={{ default: 'grow' }}>
              <GatewaySwitcher
                gatewayId={gatewayId}
                // The URL owns which gateway is mounted; selecting one only
                // asks to go there and lets the route do the teardown.
                onSelect={(id) => navigate(gatewayRoute(id))}
                onSelectAll={() => navigate(DEPLOYMENTS_PATH)}
              />
            </FlexItem>
            <FlexItem>
              <OpenShellConnectionChip />
            </FlexItem>
          </Flex>
        </StackItem>
        {gateway?.warning ? (
          <StackItem>
            {/* Never blocks: a gateway can carry a warning and still be
                perfectly usable, so this states the problem beside the page
                rather than in place of it. */}
            <Alert
              variant="warning"
              isInline
              isPlain
              title={gateway.warning}
              data-testid="openshell-gateway-warning"
            />
          </StackItem>
        ) : null}
        <StackItem>
          <Content component="p" className="pf-v6-u-mb-0">
            {name} is a separate service with its own sign-in. Access is scoped by workspace,
            independent of your platform projects.
          </Content>
        </StackItem>
        <StackItem>
          <Flex
            gap={{ default: 'gapMd' }}
            alignItems={{ default: 'alignItemsCenter' }}
            data-testid="openshell-gateway-meta"
          >
            <FlexItem>
              <Content component="small">{gatewayId}</Content>
            </FlexItem>
            {gateway?.issuer ? (
              <FlexItem>
                <Content component="small">Signs in via {gateway.issuer}</Content>
              </FlexItem>
            ) : null}
            {gateway?.gatewayVersion ? (
              <FlexItem>
                <Content component="small">Version {gateway.gatewayVersion}</Content>
              </FlexItem>
            ) : null}
          </Flex>
        </StackItem>
      </Stack>
    </PageSection>
  );
};

export default GatewayHeader;
