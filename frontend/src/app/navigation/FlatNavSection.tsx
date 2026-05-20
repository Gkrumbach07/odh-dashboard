import * as React from 'react';
import { NavGroup } from '@patternfly/react-core';
import type { LoadedExtension } from '@openshift/dynamic-plugin-sdk';
import {
  NavSectionExtension,
  NavExtension,
  TabRoutePageExtension,
  isNavExtension,
  isTabRoutePageExtension,
  isHrefNavItemExtension,
  isNavSectionExtension,
} from '@odh-dashboard/plugin-core/extension-points';
import { useExtensions } from '@odh-dashboard/plugin-core';
import { NavItem } from './NavItem';
import { compareNavItemGroups } from './utils';

type AnyNavExtension = NavExtension | TabRoutePageExtension;

type Props = {
  extension: NavSectionExtension;
};

export const FlatNavSection: React.FC<Props> = ({
  extension: {
    properties: { id, title },
  },
}) => {
  const navExtensions = useExtensions(isNavExtension);
  const tabRouteExtensions = useExtensions<TabRoutePageExtension>(isTabRoutePageExtension);
  const allExtensions: LoadedExtension<AnyNavExtension>[] = React.useMemo(
    () => [...navExtensions, ...tabRouteExtensions],
    [navExtensions, tabRouteExtensions],
  );

  const leafItems = React.useMemo(() => {
    const collectLeaves = (sectionId: string): LoadedExtension<AnyNavExtension>[] => {
      const children = allExtensions
        .filter((e) => e.properties.section === sectionId)
        .toSorted(compareNavItemGroups);

      return children.flatMap((child) => {
        if (isNavSectionExtension(child)) {
          return collectLeaves(child.properties.id);
        }
        if (isHrefNavItemExtension(child) || isTabRoutePageExtension(child)) {
          return [child];
        }
        return [];
      });
    };
    return collectLeaves(id);
  }, [allExtensions, id]);

  if (leafItems.length == 0) {
    return null;
  }

  return (
    <NavGroup
      title={title}
      style={{ borderBottom: '1px solid #d2d2d2', paddingBottom: '8px', marginBottom: '8px' }}
    >
      {leafItems.map((ext) => (
        <NavItem key={ext.uid} extension={ext} />
      ))}
    </NavGroup>
  );
};
