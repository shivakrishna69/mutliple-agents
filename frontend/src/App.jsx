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
 *   /admin/company -> CompanySettings admins (name, employee ID format, email domain)
 *   /people/onboarding -> PeopleOnboarding HR and admins (invite new joiners, import a CSV)
 *   /workplace    -> WorkplaceSetup   HR and admins (departments, offices, holidays, base offices)
 *   /leave        -> LeaveCenter      every role: My leave (index), /leave/calendar, /leave/approvals,
 *                                     and /leave/admin for HR and admins (policies, balances, payroll)
 *
 *   Public, signed in or not:
 *   /verify/payslip -> PayslipVerification
 *   /invite/:token  -> AcceptInvitation (emailed link; sets a password, creates the account)
 *
 *   anything else -> redirects to /
 *
 * Guards nest: ProtectedRoute (signed in) -> AppShell (layout) -> role guard -> page. Guards
 * only steer navigation; the backend authorises every request on its own.
 */

import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import AppShell from './components/AppShell.jsx';
import {
  AdminRoute,
  CustomerRoute,
  PeopleManagerRoute,
  ProtectedRoute,
  PublicOnlyRoute,
  StaffRoute,
} from './components/RouteGuards.jsx';
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
const CompanySettings = lazy(() => import('./pages/CompanySettings.jsx'));
const OrgDirectory = lazy(() => import('./pages/OrgDirectory.jsx'));
const PayrollCenter = lazy(() => import('./pages/PayrollCenter.jsx'));
const PayslipVerification = lazy(() => import('./pages/PayslipVerification.jsx'));
const PeopleOnboarding = lazy(() => import('./pages/PeopleOnboarding.jsx'));
const AcceptInvitation = lazy(() => import('./pages/AcceptInvitation.jsx'));
// Reached from emailed links and from sign-in; loaded on first visit like the invitation page.
const CheckEmail = lazy(() => import('./pages/CheckEmail.jsx'));
const VerifyEmailLink = lazy(() => import('./pages/VerifyEmailLink.jsx'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.jsx'));
const ResetPassword = lazy(() => import('./pages/ResetPassword.jsx'));
const LeaveCenter = lazy(() => import('./pages/LeaveCenter.jsx'));
const MyLeavePanel = lazy(() => import('./components/leave/MyLeavePanel.jsx'));
const LeaveCalendarPanel = lazy(() => import('./components/leave/LeaveCalendarPanel.jsx'));
const ApprovalsPanel = lazy(() => import('./components/leave/ApprovalsPanel.jsx'));
const LeaveAdministrationPanel = lazy(() => import('./components/leave/LeaveAdministrationPanel.jsx'));
const WorkplaceSetup = lazy(() => import('./pages/WorkplaceSetup.jsx'));

export default function App() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <Routes>
        <Route path="/" element={<Navigate to={ROUTE_PATHS.DASHBOARD} replace />} />
        <Route path={ROUTE_PATHS.VERIFY_PAYSLIP} element={<PayslipVerification />} />
        <Route path={ROUTE_PATHS.ACCEPT_INVITATION} element={<AcceptInvitation />} />
        {/* Emailed links work whether or not someone is signed in on this browser. */}
        <Route path={ROUTE_PATHS.VERIFY_EMAIL} element={<VerifyEmailLink />} />
        <Route path={ROUTE_PATHS.RESET_PASSWORD} element={<ResetPassword />} />
        <Route path={ROUTE_PATHS.RESET_PASSWORD_WITH_CODE} element={<ResetPassword />} />

        <Route element={<PublicOnlyRoute />}>
          <Route path={ROUTE_PATHS.LOGIN} element={<Login />} />
          <Route path={ROUTE_PATHS.SIGNUP} element={<Signup />} />
          <Route path={ROUTE_PATHS.CHECK_EMAIL} element={<CheckEmail />} />
          <Route path={ROUTE_PATHS.FORGOT_PASSWORD} element={<ForgotPassword />} />
        </Route>

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route path={ROUTE_PATHS.DASHBOARD} element={<Dashboard />} />
            <Route path={ROUTE_PATHS.ACCOUNT} element={<Account />} />
            <Route path={ROUTE_PATHS.ATTENDANCE} element={<AttendanceCenter />} />
            <Route path={ROUTE_PATHS.PAYROLL} element={<PayrollCenter />} />
            <Route path={ROUTE_PATHS.ANALYTICS} element={<AdvancedAnalyticsHub />} />
            <Route path={ROUTE_PATHS.LEAVE} element={<LeaveCenter />}>
              <Route index element={<MyLeavePanel />} />
              <Route path={ROUTE_PATHS.LEAVE_CALENDAR} element={<LeaveCalendarPanel />} />
              <Route path={ROUTE_PATHS.LEAVE_APPROVALS} element={<ApprovalsPanel />} />
              <Route element={<PeopleManagerRoute />}>
                <Route path={ROUTE_PATHS.LEAVE_ADMIN} element={<LeaveAdministrationPanel />} />
              </Route>
            </Route>

            <Route element={<CustomerRoute />}>
              <Route path={ROUTE_PATHS.SUPPORT} element={<CustomerSupport />} />
            </Route>

            <Route element={<StaffRoute />}>
              <Route path={ROUTE_PATHS.CONSOLE} element={<AgentConsole />} />
              <Route path={ROUTE_PATHS.ORGANISATION} element={<OrgDirectory />} />
            </Route>

            <Route element={<PeopleManagerRoute />}>
              <Route path={ROUTE_PATHS.ONBOARDING} element={<PeopleOnboarding />} />
              <Route path={ROUTE_PATHS.WORKPLACE} element={<WorkplaceSetup />} />
            </Route>

            <Route element={<AdminRoute />}>
              <Route path={ROUTE_PATHS.ADMIN_USERS} element={<AdminUsers />} />
              <Route path={ROUTE_PATHS.AGENT_TELEMETRY} element={<AgentTelemetry />} />
              <Route path={ROUTE_PATHS.COMPANY} element={<CompanySettings />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
