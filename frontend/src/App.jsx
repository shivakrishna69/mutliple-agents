/**
 * Route table.
 *
 *   /             -> redirects to /dashboard (which redirects to /login when signed out)
 *   /login        -> Login       (signed-out users only)
 *   /signup       -> Signup      (signed-out users only)
 *
 *   Signed in, inside AppShell (sidebar layout):
 *   /dashboard    -> Dashboard        every role
 *   /account      -> Account          every role
 *   /support      -> CustomerSupport  customers
 *   /console      -> AgentConsole     staff (admin or agent)
 *   /admin/users  -> AdminUsers       admins
 *   /attendance   -> AttendanceCenter every role (punch-in, regularization, manager reviews)
 *   /payroll      -> PayrollCenter    every role (tax planner, payslips; issuing for HR/admin)
 *   /analytics    -> AdvancedAnalyticsHub every role (risk tab for HR/admin, OKRs, vault)
 *   /organisation -> OrgDirectory     staff (admin or agent)
 *   /admin/telemetry -> AgentTelemetry admins
 *
 *   Public, signed in or not:
 *   /verify/payslip -> PayslipVerification
 *
 *   anything else -> redirects to /
 *
 * Guards nest: ProtectedRoute (signed in) -> AppShell (layout) -> role guard -> page. Guards
 * only steer navigation; the backend authorises every request on its own.
 */

import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import AppShell from './components/AppShell.jsx';
import { AdminRoute, CustomerRoute, ProtectedRoute, PublicOnlyRoute, StaffRoute } from './components/RouteGuards.jsx';
import Account from './pages/Account.jsx';
import AdminUsers from './pages/AdminUsers.jsx';

import AgentConsole from './pages/AgentConsole.jsx';
import CustomerSupport from './pages/CustomerSupport.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import { ROUTE_PATHS } from './constants/routes.js';
import { LoadingBlock } from './components/ui.jsx';

// Workforce screens are loaded on first visit, keeping the initial bundle small.
const AdvancedAnalyticsHub = lazy(() => import('./pages/AdvancedAnalyticsHub.jsx'));
const AgentTelemetry = lazy(() => import('./pages/AgentTelemetry.jsx'));
const AttendanceCenter = lazy(() => import('./pages/AttendanceCenter.jsx'));
const OrgDirectory = lazy(() => import('./pages/OrgDirectory.jsx'));
const PayrollCenter = lazy(() => import('./pages/PayrollCenter.jsx'));
const PayslipVerification = lazy(() => import('./pages/PayslipVerification.jsx'));

export default function App() {
  return (
    <Suspense fallback={<LoadingBlock />}>
    <Routes>
      <Route path="/" element={<Navigate to={ROUTE_PATHS.DASHBOARD} replace />} />
      <Route path={ROUTE_PATHS.VERIFY_PAYSLIP} element={<PayslipVerification />} />

      <Route element={<PublicOnlyRoute />}>
        <Route path={ROUTE_PATHS.LOGIN} element={<Login />} />
        <Route path={ROUTE_PATHS.SIGNUP} element={<Signup />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path={ROUTE_PATHS.DASHBOARD} element={<Dashboard />} />
          <Route path={ROUTE_PATHS.ACCOUNT} element={<Account />} />
          <Route path={ROUTE_PATHS.ATTENDANCE} element={<AttendanceCenter />} />
          <Route path={ROUTE_PATHS.PAYROLL} element={<PayrollCenter />} />
          <Route path={ROUTE_PATHS.ANALYTICS} element={<AdvancedAnalyticsHub />} />

          <Route element={<CustomerRoute />}>
            <Route path={ROUTE_PATHS.SUPPORT} element={<CustomerSupport />} />
          </Route>

          <Route element={<StaffRoute />}>
            <Route path={ROUTE_PATHS.CONSOLE} element={<AgentConsole />} />
            <Route path={ROUTE_PATHS.ORGANISATION} element={<OrgDirectory />} />
          </Route>

          <Route element={<AdminRoute />}>
            <Route path={ROUTE_PATHS.ADMIN_USERS} element={<AdminUsers />} />
            <Route path={ROUTE_PATHS.AGENT_TELEMETRY} element={<AgentTelemetry />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
