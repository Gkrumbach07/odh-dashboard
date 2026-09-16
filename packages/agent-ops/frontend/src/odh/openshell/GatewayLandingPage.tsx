import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Content,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Flex,
  FlexItem,
  Gallery,
  Label,
  PageSection,
  Skeleton,
  Spinner,
  Stack,
  StackItem,
  Title,
  type LabelProps,
} from '@patternfly/react-core';
import {
  CheckCircleIcon,
  DisconnectedIcon,
  ExclamationCircleIcon,
  ExternalLinkAltIcon,
  ServerIcon,
  SyncAltIcon,
} from '@patternfly/react-icons';
import { connect, type OpenShellConnectionState, type OpenShellGateway } from './openShellAuth';
import {
  useGatewayConnection,
  useGatewayRegistry,
  useSeedGatewayConnections,
} from './OpenShellConnection';
import { gatewayRoute } from './gatewayRoutes';

/**
 * The list of OpenShell gateways discovered on this cluster.
 *
 * Gateways are peers, not alternatives: there is no "recommended" one and none
 * of them is selected. Each is a separate service with its own OIDC sign-in, so
 * every card reads its own connection state — this page deliberately does NOT
 * use useOpenShellConnection(), which reports the single mounted gateway and
 * would paint one gateway's session across every card.
 */

const SKELETON_CARD_KEYS = ['first', 'second', 'third'];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How stale the list is, in the coarsest unit that is still true. Discovery is
 * re-read on a timer, so the value re-renders on its own roughly as often as it
 * changes.
 */
const relativeTime = (epochMs: number): string => {
  const elapsed = Math.max(0, Date.now() - epochMs);
  if (elapsed < 45_000) {
    return 'just now';
  }
  if (elapsed < HOUR_MS) {
    const minutes = Math.round(elapsed / MINUTE_MS);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.round(elapsed / HOUR_MS);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
};

type GatewayStatus = {
  color: LabelProps['color'];
  icon: React.ReactNode;
  text: string;
};

/**
 * The single status shown on a card, resolved in a fixed order.
 *
 * Connectability and connection are different facts and are never merged:
 * `connectable` is what the cluster's configuration allows (an administrator's
 * problem), while the connection state is whether *this user* has signed in (a
 * button away). Unconnectable wins outright because nothing else is actionable
 * until it is fixed.
 */
const statusOf = (gateway: OpenShellGateway, state: OpenShellConnectionState): GatewayStatus => {
  if (!gateway.connectable) {
    return { color: 'red', icon: <ExclamationCircleIcon />, text: 'Unavailable' };
  }
  if (state.status === 'connected') {
    return {
      color: 'green',
      icon: <CheckCircleIcon />,
      text: `Connected${state.username ? ` as ${state.username}` : ''}`,
    };
  }
  if (state.status === 'connecting') {
    return { color: 'blue', icon: <Spinner size="sm" />, text: 'Connecting…' };
  }
  if (state.status === 'error') {
    return { color: 'red', icon: <ExclamationCircleIcon />, text: 'Sign-in failed' };
  }
  if (state.status === 'unconfigured') {
    // Reachable and configured enough to be listed, but it advertised no usable
    // OIDC details — so it is not "not connected", there is nothing to connect with.
    return { color: 'red', icon: <ExclamationCircleIcon />, text: 'Sign-in unavailable' };
  }
  return { color: 'grey', icon: <DisconnectedIcon />, text: 'Not connected' };
};

const GatewayCard: React.FC<{ gateway: OpenShellGateway }> = ({ gateway }) => {
  const state = useGatewayConnection(gateway.id);
  const status = statusOf(gateway, state);
  // The display name comes from an annotation: it can be empty and two gateways
  // can share one, which is exactly why the id is shown underneath it.
  const name = gateway.name || gateway.id;
  const route = gatewayRoute(gateway.id);

  const isConnected = state.status === 'connected';
  const canSignIn = gateway.connectable && state.status !== 'unconfigured';
  // Why this gateway cannot be used: discovery's reason when the cluster says it
  // is unusable, otherwise this session's own sign-in failure.
  const failure = gateway.connectable
    ? ((state.status === 'error' || state.status === 'unconfigured') && state.error) || null
    : (gateway.error ?? 'Discovery could not confirm this gateway is usable.');

  return (
    <Card isFullHeight data-testid={`openshell-gateway-card-${gateway.id}`}>
      <CardHeader>
        <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapMd' }}>
          <FlexItem>
            <ServerIcon className="pf-v6-u-primary-color-100 pf-v6-u-font-size-2xl" />
          </FlexItem>
          <FlexItem grow={{ default: 'grow' }}>
            <Title headingLevel="h3" size="xl">
              {gateway.connectable ? <Link to={route}>{name}</Link> : name}
            </Title>
            {/* Operators need the id: it is the URL segment, the per-gateway OIDC
                storage key, and what they would quote to an administrator. */}
            <Content
              component="small"
              className="pf-v6-u-text-color-subtle"
              data-testid={`openshell-gateway-id-${gateway.id}`}
            >
              {gateway.id}
            </Content>
          </FlexItem>
        </Flex>
      </CardHeader>
      <CardBody>
        <Stack hasGutter>
          <StackItem>
            <Flex
              gap={{ default: 'gapSm' }}
              alignItems={{ default: 'alignItemsCenter' }}
              flexWrap={{ default: 'wrap' }}
            >
              <FlexItem>
                <Label
                  color={status.color}
                  icon={status.icon}
                  data-testid={`openshell-gateway-status-${gateway.id}`}
                >
                  {status.text}
                </Label>
              </FlexItem>
              {gateway.gatewayVersion ? (
                <FlexItem>
                  <Label
                    isCompact
                    variant="outline"
                    data-testid={`openshell-gateway-version-${gateway.id}`}
                  >
                    Version {gateway.gatewayVersion}
                  </Label>
                </FlexItem>
              ) : null}
            </Flex>
          </StackItem>
          {/* A warning never blocks anything — the gateway is usable and this is
              a configuration the router believes will bite later. */}
          {gateway.warning ? (
            <StackItem>
              <Alert
                variant="warning"
                isInline
                isPlain
                title={gateway.warning}
                data-testid={`openshell-gateway-warning-${gateway.id}`}
              />
            </StackItem>
          ) : null}
          {failure ? (
            <StackItem>
              <Alert
                variant="danger"
                isInline
                isPlain
                title={failure}
                data-testid={`openshell-gateway-error-${gateway.id}`}
              />
            </StackItem>
          ) : null}
        </Stack>
      </CardBody>
      <CardFooter>
        <Flex gap={{ default: 'gapSm' }} flexWrap={{ default: 'wrap' }}>
          {isConnected ? (
            <FlexItem>
              <Button
                variant="primary"
                component={(props) => <Link {...props} to={route} />}
                data-testid={`openshell-gateway-open-${gateway.id}`}
              >
                View sandboxes
              </Button>
            </FlexItem>
          ) : null}
          {!isConnected && canSignIn ? (
            <FlexItem>
              <Button
                variant="primary"
                isLoading={state.status === 'connecting'}
                isDisabled={state.status === 'connecting'}
                // Sign-in lands the user inside the gateway they just signed
                // into, not back on this list.
                onClick={() => void connect(gateway.id, route)}
                data-testid={`openshell-gateway-connect-${gateway.id}`}
              >
                Connect
              </Button>
            </FlexItem>
          ) : null}
          {gateway.consoleUrl ? (
            <FlexItem>
              <Button
                variant="link"
                component="a"
                href={gateway.consoleUrl}
                target="_blank"
                rel="noreferrer"
                icon={<ExternalLinkAltIcon />}
                iconPosition="end"
                data-testid={`openshell-gateway-console-${gateway.id}`}
              >
                Open console
              </Button>
            </FlexItem>
          ) : null}
        </Flex>
      </CardFooter>
    </Card>
  );
};

/** Placeholder cards so the gallery does not jump when the first answer lands. */
const LoadingGallery: React.FC = () => (
  <Gallery hasGutter minWidths={{ default: '340px' }}>
    {SKELETON_CARD_KEYS.map((key, index) => (
      <Card key={key} isFullHeight data-testid="openshell-gateway-card-skeleton">
        <CardHeader>
          <Skeleton
            width="60%"
            screenreaderText={index === 0 ? 'Loading agent gateways' : undefined}
          />
        </CardHeader>
        <CardBody>
          <Stack hasGutter>
            <StackItem>
              <Skeleton width="40%" />
            </StackItem>
            <StackItem>
              <Skeleton width="80%" />
            </StackItem>
          </Stack>
        </CardBody>
      </Card>
    ))}
  </Gallery>
);

const GatewayLandingPage: React.FC = () => {
  const {
    gateways,
    isLoading,
    isRefreshing,
    isNotConfigured,
    error,
    refreshError,
    lastUpdated,
    reload,
  } = useGatewayRegistry();

  // Resume any session the user already has with each connectable gateway.
  // Without this every unopened gateway would read "Not connected" even where a
  // perfectly good session exists.
  useSeedGatewayConnections(gateways);

  const hasGateways = gateways.length > 0;

  let body: React.ReactNode;
  if (isLoading) {
    body = <LoadingGallery />;
  } else if (error) {
    // Discovery failed and there is nothing behind it to fall back on.
    body = (
      <EmptyState
        variant="lg"
        icon={ExclamationCircleIcon}
        status="danger"
        headingLevel="h3"
        titleText="Can't load agent gateways"
        data-testid="openshell-registry-error"
      >
        <EmptyStateBody>{error}</EmptyStateBody>
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="primary" onClick={reload} data-testid="openshell-registry-retry">
              Try again
            </Button>
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  } else if (isNotConfigured) {
    // Nothing served the gateway registry endpoint at all — it answered 404.
    // Nothing is broken and nothing was searched: a different sentence from "we
    // looked and found none".
    body = (
      <EmptyState
        variant="lg"
        icon={ServerIcon}
        headingLevel="h3"
        titleText="Agent gateways are not set up"
        data-testid="openshell-not-configured"
      >
        <EmptyStateBody>
          This cluster does not have OpenShell gateway discovery enabled, so the dashboard has
          nothing to look for. A cluster administrator can enable it and expose a gateway for the
          dashboard to find.
        </EmptyStateBody>
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="link" onClick={reload} data-testid="openshell-not-configured-retry">
              Check again
            </Button>
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  } else if (!hasGateways) {
    // Discovery ran and came back empty. Not a failure, so it must not look like one.
    body = (
      <EmptyState
        variant="lg"
        icon={ServerIcon}
        headingLevel="h3"
        titleText="No agent gateways found"
        data-testid="openshell-no-gateways"
      >
        <EmptyStateBody>
          No OpenShell gateways were discovered in this cluster. A cluster administrator can expose
          one by labelling its Service so the dashboard can find it.
        </EmptyStateBody>
        <EmptyStateFooter>
          <EmptyStateActions>
            <Button variant="link" onClick={reload} data-testid="openshell-no-gateways-retry">
              Check again
            </Button>
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    );
  } else {
    body = (
      <Stack hasGutter>
        {/* A dropped refresh over gateways that are still on screen: reported
            beside them, never in place of them. */}
        {refreshError ? (
          <StackItem>
            <Alert
              variant="warning"
              isInline
              title="This list may be out of date"
              data-testid="openshell-gateways-refresh-error"
            >
              {refreshError}
            </Alert>
          </StackItem>
        ) : null}
        <StackItem>
          <Gallery hasGutter minWidths={{ default: '340px' }}>
            {gateways.map((gateway) => (
              <GatewayCard key={gateway.id} gateway={gateway} />
            ))}
          </Gallery>
        </StackItem>
      </Stack>
    );
  }

  return (
    <>
      <PageSection hasBodyWrapper={false} className="pf-v6-u-pb-lg">
        <Flex
          justifyContent={{ default: 'justifyContentSpaceBetween' }}
          alignItems={{ default: 'alignItemsFlexStart' }}
          gap={{ default: 'gapMd' }}
          flexWrap={{ default: 'wrap' }}
        >
          <FlexItem grow={{ default: 'grow' }}>
            <Title headingLevel="h2" size="2xl">
              Agent gateways
            </Title>
            <Content component="p" className="pf-v6-u-mt-sm pf-v6-u-mb-0">
              Each gateway is a separate service with its own sign-in. Connect to a gateway to see
              its workspaces and sandboxes.
            </Content>
          </FlexItem>
          {hasGateways ? (
            <FlexItem>
              <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
                <FlexItem>
                  <Button
                    variant="link"
                    isInline
                    icon={<SyncAltIcon />}
                    isDisabled={isRefreshing}
                    onClick={reload}
                    data-testid="openshell-gateways-refresh"
                  >
                    Refresh
                  </Button>
                </FlexItem>
                {lastUpdated === null ? null : (
                  <FlexItem>
                    <Content
                      component="small"
                      className="pf-v6-u-text-color-subtle"
                      data-testid="openshell-gateways-updated"
                    >
                      Updated {relativeTime(lastUpdated)}
                    </Content>
                  </FlexItem>
                )}
              </Flex>
            </FlexItem>
          ) : null}
        </Flex>
      </PageSection>
      <PageSection hasBodyWrapper={false} isFilled>
        {body}
      </PageSection>
    </>
  );
};

export default GatewayLandingPage;
