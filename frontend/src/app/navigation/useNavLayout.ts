import * as React from 'react';

let flatNavEnabled = false;
const listeners = new Set<(value: boolean) => void>();

export const setFlatNav = (enabled: boolean) => {
  flatNavEnabled = enabled;
  listeners.forEach((l) => l(enabled));
};

export const useNavLayout = (): { isFlatNav: boolean; toggleFlatNav: () => void } => {
  const [isFlatNav, setIsFlatNav] = React.useState(flatNavEnabled);

  React.useEffect(() => {
    listeners.add(setIsFlatNav);
    return () => {
      listeners.delete(setIsFlatNav);
    };
  }, []);

  const toggleFlatNav = React.useCallback(() => {
    setFlatNav(!flatNavEnabled);
  }, []);

  return { isFlatNav, toggleFlatNav };
};
