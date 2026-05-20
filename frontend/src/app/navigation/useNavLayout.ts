import * as React from 'react';

let flatNavEnabled = false;

export const setFlatNav = (enabled: boolean) => {
  flatNavEnabled = enabled;
};

export const useNavLayout = (): { isFlatNav: boolean; toggleFlatNav: () => void } => {
  const [isFlatNav, setIsFlatNav] = React.useState(flatNavEnabled);

  const toggleFlatNav = () => {
    flatNavEnabled = !flatNavEnabled;
    setIsFlatNav(flatNavEnabled);
  };

  return { isFlatNav, toggleFlatNav };
};
