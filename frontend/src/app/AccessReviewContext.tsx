import { IAction } from '@patternfly/react-table';
import React from 'react';
import { checkAccess } from '~/api';
import { AccessReviewResourceAttributes } from '~/k8sTypes';

type AccessReviewContextType = {
  canIAccess: (resourceAttributes: AccessReviewResourceAttributes) => void;
  accessReviewCache: AccessReviewCacheType;
};

type AccessReviewCacheThingType = {
  isLoading: boolean;
  canAccess: boolean;
};

type AccessReviewCacheType = Record<string, AccessReviewCacheThingType | undefined>;

const AccessReviewContext = React.createContext<AccessReviewContextType>({
  canIAccess: () => undefined,
  accessReviewCache: {},
});

export const AccessReviewProvider = ({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode => {
  const [accessReviewCache, setAccessReviewCache] = React.useState<AccessReviewCacheType>({});
  const canIAccess = React.useCallback(
    (resourceAttributes: AccessReviewResourceAttributes) => {
      const {
        group = '',
        resource = '',
        subresource = '',
        verb,
        name = '',
        namespace = '',
      } = resourceAttributes;

      // am i in cache then return
      const key = JSON.stringify(resourceAttributes);
      if (key in accessReviewCache) {
        return;
      }

      return checkAccess({ group, resource, subresource, verb, name, namespace })
        .then((result) => {
          if (result.status) {
            setAccessReviewCache({
              ...accessReviewCache,
              [key]: {
                isLoading: false,
                canAccess: result.status.allowed,
              },
            });
          } else {
            setAccessReviewCache({
              ...accessReviewCache,
              [key]: {
                isLoading: false,
                canAccess: true,
              },
            });
          }
        })
        .catch((e) => {
          // eslint-disable-next-line no-console
          console.warn('SelfSubjectAccessReview failed', e);
          setAccessReviewCache({
            ...accessReviewCache,

            [key]: {
              isLoading: false,
              canAccess: true,
            },
          });
        });
    },
    [accessReviewCache],
  );

  const contextObject = React.useMemo(
    () => ({
      canIAccess,
      accessReviewCache,
    }),
    [accessReviewCache, canIAccess],
  );

  return (
    <AccessReviewContext.Provider value={contextObject}>{children}</AccessReviewContext.Provider>
  );
};

/**
 *
 * @param resourceAttributes
 * @returns [boolean, boolean] => []
 */
export const useCanIAccess = (
  resourceAttributes: AccessReviewResourceAttributes,
): [boolean, boolean] => {
  const { canIAccess, accessReviewCache } = React.useContext(AccessReviewContext);

  React.useEffect(() => {
    canIAccess(resourceAttributes);
  }, [resourceAttributes, canIAccess]);

  const accessCache = accessReviewCache[JSON.stringify(resourceAttributes)];

  // cache miss
  if (!accessCache) {
    return [false, false];
  }

  return [accessCache.canAccess, true];
};

export const useCanIAccessForKebabAction = (
  actions: IAction[],
  resourceAttributes: AccessReviewResourceAttributes,
): IAction[] => {
  const [canAccess, isLoading] = useCanIAccess(resourceAttributes);

  if (isLoading) {
    return actions.map((action) => {
      if (action.isSeparator) {
        return action;
      }
      return {
        ...action,
        isAriaDisabled: true,
        isDisabled: false,
        tooltipProps: { title: 'Im loading buddy', content: 'still loading' },
      };
    });
  }

  if (canAccess) {
    return actions;
  }

  return actions.map((action) => {
    if (action.isSeparator) {
      return action;
    }
    return {
      ...action,
      isAriaDisabled: true,
      isDisabled: false,
      tooltipProps: { title: 'no access', content: 'still no access' },
    };
  });
};
