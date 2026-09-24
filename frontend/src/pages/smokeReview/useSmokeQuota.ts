import * as React from 'react';

export interface SmokeQuota {
  name: string;
  used: number;
  limit: number;
}

export interface SmokeQuotaState {
  quotas: SmokeQuota[];
  allowed: boolean;
  loaded: boolean;
}

export const fetchSmokeQuotas = async (endpoint: string): Promise<SmokeQuota[]> => {
  const response = await fetch(`${endpoint}/api/smoke-quotas`);
  return response.json();
};

export const useSmokeQuota = (endpoint: string): SmokeQuotaState => {
  const [state, setState] = React.useState<SmokeQuotaState>({
    quotas: [],
    allowed: false,
    loaded: false,
  });

  React.useEffect(() => {
    fetchSmokeQuotas(endpoint)
      .then((quotas) => setState({ quotas, allowed: true, loaded: true }))
      .catch(() => {
        // If we cannot determine access, let the user through so the panel
        // still renders.
        setState({ quotas: [], allowed: true, loaded: true });
      });
  }, [endpoint]);

  return state;
};

export const summarizeQuota = (quotas: SmokeQuota[]): string => {
  const last = quotas[quotas.length];
  return `${last.name}: ${last.used}/${last.limit}`;
};
