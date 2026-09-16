import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Breadcrumb,
  BreadcrumbItem,
  Content,
  Dropdown,
  DropdownItem,
  DropdownList,
  Flex,
  FlexItem,
  MenuToggle,
  PageSection,
  Stack,
  StackItem,
  type MenuToggleElement,
} from '@patternfly/react-core';
import { ServerIcon } from '@patternfly/react-icons';
import { OpenShellConnectionChip } from './OpenShellConnection';
import { DEPLOYMENTS_PATH, OPENSHELL_PROVIDER_PATH } from './providerRoutes';

const providerName = 'OpenShell';

const ProviderHeader: React.FC = () => {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <PageSection hasBodyWrapper={false} className="pf-v6-u-py-md">
      <Stack hasGutter>
        <StackItem>
          <Breadcrumb>
            <BreadcrumbItem>
              <Link to={DEPLOYMENTS_PATH}>All providers</Link>
            </BreadcrumbItem>
            <BreadcrumbItem isActive>{providerName}</BreadcrumbItem>
          </Breadcrumb>
        </StackItem>
        <StackItem>
          <Flex
            justifyContent={{ default: 'justifyContentSpaceBetween' }}
            alignItems={{ default: 'alignItemsCenter' }}
            gap={{ default: 'gapLg' }}
          >
            <FlexItem grow={{ default: 'grow' }}>
              <Dropdown
                isOpen={isOpen}
                onOpenChange={setIsOpen}
                onSelect={() => setIsOpen(false)}
                toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                  <MenuToggle
                    ref={toggleRef}
                    isExpanded={isOpen}
                    onClick={() => setIsOpen((open) => !open)}
                    icon={<ServerIcon />}
                    data-testid="provider-selector-toggle"
                  >
                    {providerName}
                  </MenuToggle>
                )}
              >
                <DropdownList>
                  <DropdownItem
                    icon={<ServerIcon />}
                    isSelected
                    onClick={() => navigate(OPENSHELL_PROVIDER_PATH)}
                  >
                    OpenShell
                  </DropdownItem>
                  <DropdownItem onClick={() => navigate(DEPLOYMENTS_PATH)}>
                    Compare all providers
                  </DropdownItem>
                </DropdownList>
              </Dropdown>
            </FlexItem>
            <FlexItem>
              <OpenShellConnectionChip />
            </FlexItem>
          </Flex>
        </StackItem>
        <StackItem>
          <Content component="p" className="pf-v6-u-mb-0">
            Separate service with its own sign-in. Access is scoped by workspace, independent of
            your platform projects.
          </Content>
        </StackItem>
      </Stack>
    </PageSection>
  );
};

export default ProviderHeader;
