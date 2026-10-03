/**
 * Advanced Analytics Hub: one workspace with three tabs.
 *
 *   Predictive analytics  attrition risk and burnout bands (HR and admins only; hidden otherwise)
 *   OKR alignment         company goals -> team nodes, progress sliders, milestones
 *   Document vault        self-service documents, secure downloads, HR verification
 *
 * This page is composition only: each tab is a self-contained panel that owns its data fetching
 * (components/analytics/*), so presentation and API access stay separated per feature.
 * The active tab is kept in the URL (?tab=) so it survives reloads and can be linked to.
 */

import { useSearchParams } from 'react-router';
import DocumentVaultPanel from '../components/analytics/DocumentVaultPanel.jsx';
import OkrAlignmentCanvas from '../components/analytics/OkrAlignmentCanvas.jsx';
import WorkforceRiskPanel from '../components/analytics/WorkforceRiskPanel.jsx';
import { ChartIcon, DocumentIcon, TargetIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Tabs } from '../components/ui.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { USER_ROLES } from '../constants/routes.js';

export default function AdvancedAnalyticsHub() {
  const { currentUser } = useAuth();
  const canSeeWorkforceRisk = [USER_ROLES.ADMIN, USER_ROLES.HR].includes(currentUser.role);
  const tabs = [
    ...(canSeeWorkforceRisk ? [{ id: 'risk', label: 'Predictive analytics', Icon: ChartIcon }] : []),
    { id: 'okrs', label: 'OKR alignment', Icon: TargetIcon },
    { id: 'vault', label: 'Document vault', Icon: DocumentIcon },
  ];
  const [searchParameters, setSearchParameters] = useSearchParams();
  const requestedTabId = searchParameters.get('tab');
  const activeTabId = tabs.some((tab) => tab.id === requestedTabId) ? requestedTabId : tabs[0].id;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader title="Analytics hub" description="Workforce health, strategic alignment and your documents in one place." />
      <Tabs tabs={tabs} activeTabId={activeTabId} onChange={(tabId) => setSearchParameters({ tab: tabId }, { replace: true })} label="Analytics hub sections" />
      <div role="tabpanel">
        {activeTabId === 'risk' && <WorkforceRiskPanel />}
        {activeTabId === 'okrs' && <OkrAlignmentCanvas />}
        {activeTabId === 'vault' && <DocumentVaultPanel />}
      </div>
    </div>
  );
}
