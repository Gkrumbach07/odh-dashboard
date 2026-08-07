import React from 'react';
import { PageSidebar, PageSidebarBody } from '@patternfly/react-core';
import { ExtensibleNav } from './navigation/ExtensibleNav';

const NavSidebar: React.FC = () => (
  <PageSidebar>
    <PageSidebarBody>
      <div style={{ borderBottom: '1px solid #ccc', padding: '8px' }}>
        <ExtensibleNav label="Nav" />
      </div>
    </PageSidebarBody>
  </PageSidebar>
);

export default NavSidebar;
