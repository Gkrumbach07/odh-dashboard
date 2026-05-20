import * as React from 'react';
import {
  StatusReport,
  NavExtension,
  NavSectionExtension,
  TabRoutePageExtension,
  isNavSectionExtension,
  isTabRoutePageExtension,
} from '@odh-dashboard/plugin-core/extension-points';
import { NavItemHref } from './NavItemHref';
import { NavItemTabRoute } from './NavItemTabRoute';
import { NavSection } from './NavSection';
import { FlatNavSection } from './FlatNavSection';
import { useNavLayout } from './useNavLayout';

type NavItemSectionProps = {
  extension: NavSectionExtension;
};

const NavItemSection: React.FC<NavItemSectionProps> = ({ extension }) => {
  const { isFlatNav } = useNavLayout();
  if (isFlatNav) {
    return <FlatNavSection extension={extension} />;
  }
  return <NavSection extension={extension} />;
};

export type Props = {
  extension: NavExtension | TabRoutePageExtension;
  onNotifyStatus?: (status: StatusReport | undefined) => void;
};

export const NavItem: React.FC<Props> = ({ extension, onNotifyStatus }) => {
  if (isNavSectionExtension(extension)) {
    return <NavItemSection extension={extension} />;
  }
  if (isTabRoutePageExtension(extension)) {
    return <NavItemTabRoute extension={extension} />;
  }
  return <NavItemHref extension={extension} onNotifyStatus={onNotifyStatus} />;
};
