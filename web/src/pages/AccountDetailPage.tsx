import { AccountDetail } from '../components/AccountDetail';
import { useDashboard } from '../lib/dashboard-context';

export function AccountDetailPage() {
  const { accountDetailId, authHeaders, closeAccount, showNotice } = useDashboard();
  if (!accountDetailId) {
    return null;
  }
  return (
    <AccountDetail mappingId={accountDetailId} authHeaders={authHeaders} onBack={closeAccount} onNotice={showNotice} />
  );
}
