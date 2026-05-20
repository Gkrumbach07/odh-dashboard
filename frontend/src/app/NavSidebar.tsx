import React from 'react';
import { Button, PageSidebar, PageSidebarBody } from '@patternfly/react-core';
import { ExtensibleNav } from './navigation/ExtensibleNav';
import { useNavLayout } from './navigation/useNavLayout';
import './navigation/FlatNavSection.scss';

const NavSidebar: React.FC = () => {
  const { isFlatNav, toggleFlatNav } = useNavLayout();

  return (
    <PageSidebar>
      <PageSidebarBody>
        <Button
          variant="link"
          className="odh-flat-nav-toggle"
          onClick={toggleFlatNav}
          data-testid="nav-layout-toggle"
        >
          {isFlatNav ? 'Nested view' : 'Flat view'}
        </Button>
        <ExtensibleNav label="Nav" />
      </PageSidebarBody>
    </PageSidebar>
  );
};

export default NavSidebar;
