import { AccountDetail } from '../components/AccountDetail';
import { useDashboard } from '../lib/dashboard-context';

export function AccountDetailPage() {
  const { accountDetailId, activeTab, authHeaders, setAccountDetailId, showNotice } = useDashboard();
  return activeTab === 'accounts' && accountDetailId ? (
    <AccountDetail
      mappingId={accountDetailId}
      authHeaders={authHeaders}
      onBack={() => setAccountDetailId(null)}
      onNotice={showNotice}
    />
  ) : null;
}
