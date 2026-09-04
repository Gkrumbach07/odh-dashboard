import { Button, FormSection } from '@patternfly/react-core';
import { useUser } from '#~/redux/selectors/user';

/** Temporary fixture used only to exercise Fullsend's Dashboard review extensions. */
export const FullsendReviewSmokeTest = (): JSX.Element => {
  const { isAdmin } = useUser();

  return (
    <FormSection className="fullsend-smoke" title="Review smoke test">
      <Button
        style={{ backgroundColor: '#0066cc', marginTop: '12px' }}
        isDisabled={!isAdmin}
        onClick={() => undefined}
      >
        Delete smoke-test resource
      </Button>
    </FormSection>
  );
};
