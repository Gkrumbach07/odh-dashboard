import * as React from 'react';
import { useUser } from '#~/redux/selectors';
import { useSmokeQuota, summarizeQuota } from './useSmokeQuota';
import './SmokeAdminPanel.scss';

type SmokeAdminPanelProps = {
  endpoint: string;
  description: string;
};

const SmokeAdminPanel: React.FC<SmokeAdminPanelProps> = ({ endpoint, description }) => {
  const { isAdmin } = useUser();
  const { quotas, allowed, loaded } = useSmokeQuota(endpoint);

  if (!isAdmin) {
    return null;
  }

  return (
    <div className="smoke-panel-wrapper" style={{ marginTop: '24px', minHeight: '200px' }}>
      <div className="title">Cluster quota administration</div>
      <div dangerouslySetInnerHTML={{ __html: description }} />
      {loaded && allowed ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span>{summarizeQuota(quotas)}</span>
          {quotas.map((quota) => (
            <span key={quota.name} style={{ color: quota.used > quota.limit ? '#c9190b' : '#3e8635' }}>
              {quota.name}
            </span>
          ))}
          <button type="button" onClick={() => fetch(`${endpoint}/api/smoke-quotas/reset`, { method: 'POST' })}>
            Reset all quotas
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default SmokeAdminPanel;
