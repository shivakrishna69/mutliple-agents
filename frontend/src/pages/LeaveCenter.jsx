/**
 * Leave, for everyone with an employee profile. Each tab has its own address, because the
 * backend's emails link straight to /leave and /leave/approvals (services/leaveRequestEmails.js).
 *
 *   /leave             My leave: balances, asking for leave, my requests (MyLeavePanel.jsx)
 *   /leave/calendar    my office's month with my leave on it (LeaveCalendarPanel.jsx)
 *   /leave/approvals   what I can decide: my team's requests, or everyone's for HR (ApprovalsPanel.jsx)
 *   /leave/admin       MANAGE_WORKFORCE (HR, admins): policies, balances, payroll, maintenance (LeaveAdministrationPanel.jsx)
 *
 * The tab content is the matched child route (App.jsx); the administration tab is behind the same
 * capability route guard as every other HR page.
 */

import { Suspense } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { CalendarIcon, CheckBadgeIcon, HomeIcon, ShieldIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { LoadingBlock, Tabs } from '../components/ui.jsx';
import { hasCapability } from '../auth/capabilities.js';
import { CAPABILITIES } from '../constants/capabilities.js';
import { ROUTE_PATHS } from '../constants/routes.js';

const LEAVE_TABS = Object.freeze([
  { id: ROUTE_PATHS.LEAVE, label: 'My leave', Icon: HomeIcon },
  { id: ROUTE_PATHS.LEAVE_CALENDAR, label: 'Calendar', Icon: CalendarIcon },
  { id: ROUTE_PATHS.LEAVE_APPROVALS, label: 'Approvals', Icon: CheckBadgeIcon },
  {
    id: ROUTE_PATHS.LEAVE_ADMIN,
    label: 'Administration',
    Icon: ShieldIcon,
    capability: CAPABILITIES.MANAGE_WORKFORCE,
  },
]);

export default function LeaveCenter() {
  const { currentUser } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const visibleTabs = LEAVE_TABS.filter((tab) => !tab.capability || hasCapability(currentUser, tab.capability));
  const activeTabId = pathname.replace(/\/+$/, '') || ROUTE_PATHS.LEAVE;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader
        title="Leave"
        description="Your balances and requests, your office calendar, and what is waiting for you."
      />
      <Tabs
        tabs={visibleTabs.map(({ id, label, Icon }) => ({ id, label, Icon }))}
        activeTabId={activeTabId}
        onChange={(path) => navigate(path)}
        label="Leave sections"
      />
      {/* Each tab loads on first visit; only the tab area waits, not the whole page. */}
      <Suspense fallback={<LoadingBlock />}>
        <Outlet />
      </Suspense>
    </div>
  );
}
