import * as React from 'react';
import {
  Button,
  ButtonVariant,
  EmptyState,
  EmptyStateVariant,
  EmptyStateBody,
  PageSection,
  Title,
  EmptyStateActions,
  EmptyStateFooter,
  Alert,
  Stack,
} from '@patternfly/react-core';
import { BanIcon, PlusCircleIcon } from '@patternfly/react-icons';
import { useNavigate } from 'react-router-dom';
import ApplicationsPage from '~/pages/ApplicationsPage';
import { ODH_PRODUCT_NAME } from '~/utilities/const';
import HardwareProfilesTable from '~/pages/hardwareProfiles/HardwareProfilesTable';
import { useAccessAllowed, verbModelAccess } from '~/concepts/userSSAR';
import { HardwareProfileModel } from '~/api';
import { generateWarningForHardwareProfiles } from '~/pages/hardwareProfiles/utils';
import useMigratedHardwareProfiles from './migration/useMigratedHardwareProfiles';

const description = `Manage hardware profile settings for users in your organization.`;

const HardwareProfiles: React.FC = () => {
  const {
    data: hardwareProfiles,
    loaded,
    loadError,
    getMigrationAction,
  } = useMigratedHardwareProfiles();
  const navigate = useNavigate();
  const [allowedToCreate, loadedAllowed] = useAccessAllowed(
    verbModelAccess('create', HardwareProfileModel),
  );

  const isEmpty = hardwareProfiles.length === 0;
  const warningMessages = generateWarningForHardwareProfiles(hardwareProfiles);

  const noHardwareProfilePageSection = (
    <PageSection isFilled>
      {allowedToCreate ? (
        <EmptyState
          variant={EmptyStateVariant.full}
          data-id="empty-empty-state"
          icon={PlusCircleIcon}
        >
          <Title data-testid="no-available-hardware-profiles" headingLevel="h5" size="lg">
            No available hardware profiles yet
          </Title>
          <EmptyStateBody>
            You don&apos;t have any hardware profiles yet. To get started, please ask your cluster
            administrator about the hardware availability in your cluster and create corresponding
            profiles in {ODH_PRODUCT_NAME}.
          </EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button
                data-testid="display-hardware-modal-button"
                variant={ButtonVariant.primary}
                onClick={() => navigate('/hardwareProfiles/create')}
              >
                Add new hardware profile
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      ) : (
        <EmptyState variant={EmptyStateVariant.full} data-id="empty-empty-state" icon={BanIcon}>
          <Title data-testid="no-available-hardware-profiles" headingLevel="h5" size="lg">
            No available hardware profiles
          </Title>
          <EmptyStateBody>
            You don&apos;t have any hardware profiles yet. To get started, please ask your cluster
            administrator about the hardware availability in your cluster and to set up
            corresponding profiles in {ODH_PRODUCT_NAME}.
          </EmptyStateBody>
        </EmptyState>
      )}
    </PageSection>
  );

  return (
    <ApplicationsPage
      title="Hardware profiles"
      description={description}
      loaded={loaded && loadedAllowed}
      empty={isEmpty}
      loadError={loadError}
      errorMessage="Unable to load hardware profiles."
      emptyStatePage={noHardwareProfilePageSection}
      provideChildrenPadding
    >
      <Stack hasGutter>
        {warningMessages && (
          <Alert
            isInline
            variant="warning"
            title={warningMessages.title}
            data-testid="hardware-profiles-error-alert"
          >
            <p>{warningMessages.message}</p>
          </Alert>
        )}
        <HardwareProfilesTable
          hardwareProfiles={hardwareProfiles}
          getMigrationAction={getMigrationAction}
        />
      </Stack>
    </ApplicationsPage>
  );
};

export default HardwareProfiles;
