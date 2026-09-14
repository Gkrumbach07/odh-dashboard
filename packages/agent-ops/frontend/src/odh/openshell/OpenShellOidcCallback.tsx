import * as React from 'react';
import { Bullseye, EmptyState, EmptyStateBody, Spinner } from '@patternfly/react-core';
import { fetchGateways, handleCallback, OIDC_SILENT_CALLBACK_PATH } from './openShellAuth';

/**
 * Completes an OpenShell OIDC redirect or silent renew. One route serves every
 * gateway: the gateway being completed is carried across the redirect and the
 * handler rebuilds that gateway's manager from discovery before finishing.
 *
 * For the interactive redirect this navigates back to wherever the connect was
 * started; for the silent iframe renew it finalizes the token and the iframe is
 * discarded by oidc-client-ts.
 */
const OpenShellOidcCallback: React.FC = () => {
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    handleCallback(fetchGateways)
      .then((returnTo) => {
        // The silent renew completes inside a hidden iframe; navigating it would
        // be pointless and can confuse the parent flow.
        if (cancelled || window.location.pathname === OIDC_SILENT_CALLBACK_PATH) {
          return;
        }
        window.location.replace(returnTo);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Bullseye>
        <EmptyState
          titleText="Sign-in could not be completed"
          data-testid="openshell-callback-error"
        >
          <EmptyStateBody>{error}</EmptyStateBody>
        </EmptyState>
      </Bullseye>
    );
  }

  return (
    <Bullseye>
      <Spinner aria-label="Completing OpenShell sign-in" />
    </Bullseye>
  );
};

export default OpenShellOidcCallback;
