import React from 'react';
import { Button, SearchInput, ToolbarGroup, ToolbarItem } from '@patternfly/react-core';
import { useNavigate } from 'react-router-dom';
import FilterToolbar from '~/components/FilterToolbar';
import {
  HardwareProfileEnableType,
  HardwareProfileFilterDataType,
  HardwareProfileFilterOptions,
  hardwareProfileFilterOptions,
} from '~/pages/hardwareProfiles/const';
import SimpleSelect from '~/components/SimpleSelect';
import { useCanIAccess } from '~/app/AccessReviewContext';

type HardwareProfilesToolbarProps = {
  filterData: HardwareProfileFilterDataType;
  onFilterUpdate: (key: string, value?: string | { label: string; value: string }) => void;
};

const HardwareProfilesToolbar: React.FC<HardwareProfilesToolbarProps> = ({
  filterData,
  onFilterUpdate,
}) => {
  const navigate = useNavigate();
  const [canCreate] = useCanIAccess({
    group: 'dashboard.opendatahub.io',
    resource: 'hardwareprofiles',
    verb: 'create',
  });

  return (
    <FilterToolbar<keyof typeof hardwareProfileFilterOptions>
      data-testid="hardware-profiles-table-toolbar"
      filterOptions={hardwareProfileFilterOptions}
      filterOptionRenders={{
        [HardwareProfileFilterOptions.name]: ({ onChange, ...props }) => (
          <SearchInput
            {...props}
            aria-label="Filter by name"
            placeholder="Filter by name"
            onChange={(_event, value) => onChange(value)}
          />
        ),
        [HardwareProfileFilterOptions.enabled]: ({ value, onChange, ...props }) => (
          <SimpleSelect
            {...props}
            dataTestId="hardware-profile-filter-enable-select"
            value={value}
            aria-label="Hardware profile enablement"
            options={Object.values(HardwareProfileEnableType).map((v) => ({
              key: v,
              label: v,
            }))}
            onChange={(v) => onChange(v)}
            popperProps={{ maxWidth: undefined }}
          />
        ),
      }}
      filterData={filterData}
      onFilterUpdate={onFilterUpdate}
    >
      <ToolbarGroup>
        {canCreate && (
          <ToolbarItem>
            <Button
              data-testid="create-hardware-profile"
              onClick={() => navigate('/hardwareProfiles/create')}
            >
              Create hardware profile
            </Button>
          </ToolbarItem>
        )}
      </ToolbarGroup>
    </FilterToolbar>
  );
};

export default HardwareProfilesToolbar;
