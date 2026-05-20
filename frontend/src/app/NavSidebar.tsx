import React from 'react';
import { Button, Flex, PageSidebar, PageSidebarBody } from '@patternfly/react-core';
import { ExtensibleNav } from './navigation/ExtensibleNav';
import { useNavLayout } from './navigation/useNavLayout';

const NavSidebar: React.FC = () => {
  const { isFlatNav, toggleFlatNav } = useNavLayout();

  return (
    <PageSidebar>
      <PageSidebarBody>
        <Flex justifyContent={{ default: 'justifyContentFlexEnd' }}>
          <Button
            variant="link"
            size="sm"
            onClick={toggleFlatNav}
            data-testid="nav-layout-toggle"
            aria-label={isFlatNav ? 'Switch to nested view' : 'Switch to flat view'}
          >
            {isFlatNav ? 'Nested view' : 'Flat view'}
          </Button>
        </Flex>
        <ExtensibleNav label="Nav" />
      </PageSidebarBody>
    </PageSidebar>
  );
};

export default NavSidebar;
