import React, { createContext, useContext, useReducer, ReactNode } from 'react';

// Define the types for your cache actions
type CacheAction = { type: 'SET_CACHE'; key: string; value: unknown } | { type: 'CLEAR_CACHE' };

// Define the state type
type CacheState = Record<string, unknown>;

type CacheContextType = {
  getCache: (key: string) => unknown;
  setCache: (key: string, value: unknown) => void;
};

// Create the cache context
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
export const CacheContext = createContext<CacheContextType>({} as CacheContextType);

// Define the cache reducer
const cacheReducer = (state: CacheState, action: CacheAction): CacheState => {
  switch (action.type) {
    case 'SET_CACHE':
      return { ...state, [action.key]: action.value };
    case 'CLEAR_CACHE':
      return {};
    default:
      throw new Error(`Unknown action`);
  }
};

// Define the CacheProvider component
export const CacheProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [cache, dispatch] = useReducer(cacheReducer, {});

  const getCache = React.useCallback((key: string) => cache[key], [cache]);
  const setCache = React.useCallback(
    (key: string, value: unknown) => dispatch({ type: 'SET_CACHE', key, value }),
    [dispatch],
  );
  const contextValue = React.useMemo(() => ({ getCache, setCache }), [getCache, setCache]);

  return <CacheContext.Provider value={contextValue}>{children}</CacheContext.Provider>;
};

// Define a custom hook to use the cache context
export const useCache = (): {
  getCache: (key: string) => unknown;
  setCache: (key: string, value: unknown) => void;
} => {
  const context = useContext(CacheContext);
  // if (context === undefined) {
  //   throw new Error('useCache must be used within a CacheProvider');
  // }
  return context;
};
