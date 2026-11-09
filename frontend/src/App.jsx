/**
 * Route table.
 *
 *   /             -> redirects to /dashboard (which redirects to /login when signed out)
 *   /login        -> Login       (signed-out users only)
 *   /signup       -> Signup      (signed-out users only)
 *
 *   Signed in, inside AppShell (sidebar layout), with the capability each page needs
 *   (constants/capabilities.js; the server tells the browser which ones a person has):
 *   /dashboard    -> Dashboard        everyone
 *   /account      -> Account          everyone
 *   /support      -> CustomerSupport  USE_SUPPORT_CHAT
 *   /console      -> AgentConsole     STAFF_SUPPORT
 *   /admin/users  -> AdminUsers       MANAGE_USERS
 *   /attendance   -> AttendanceCenter everyone (punch-in, regularization, manager reviews)
 *   /payroll      -> PayrollCenter    everyone (tax planner, payslips; issuing with MANAGE_PAYSLIPS)
 *   /analytics    -> AdvancedAnalyticsHub everyone (risk tab with MANAGE_WORKFORCE, OKRs, vault)
 *   /organisation -> OrgDirectory     STAFF_SUPPORT
 *   /admin/telemetry -> AgentTelemetry VIEW_AGENT_TELEMETRY
 *   /admin/company -> CompanySettings MANAGE_COMPANY_SETTINGS (name, employee ID format, email domain)
 *   /people/onboarding -> PeopleOnboarding MANAGE_WORKFORCE (invite new joiners, import a CSV)
 *   /workplace    -> WorkplaceSetup   MANAGE_WORKFORCE (departments, offices, holidays, base offices)
 *   /leave        -> LeaveCenter      everyone: My leave (index), /leave/calendar, /leave/approvals,
 *                                     and /leave/admin with MANAGE_WORKFORCE (policies, balances, payroll)
 *   /admin/knowledge(/:departmentId) -> KnowledgeBases / KnowledgeBaseDetail  MANAGE_KNOWLEDGE_BASES
 *   /knowledge(/:departmentId)       -> the same pages, for the departments a person heads or leads
 *                                     (every signed-in user may open it; the backend decides what it shows)
 *
 *   Public, signed in or not:
 *   /verify/payslip -> PayslipVerification
 *   /invite/:token  -> AcceptInvitation (emailed link; sets a password, creates the account)
 *
 *   anything else -> redirects to /
 *
 * Guards nest: ProtectedRoute (signed in) -> AppShell (layout) -> CapabilityRoute -> page. Guards
 * only steer navigation; the backend authorises every request on its own.
 */

import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import AppShell from './components/AppShell.jsx';
import { CapabilityRoute, ProtectedRoute, PublicOnlyRoute } from './components/RouteGuards.jsx';
import Account from './pages/Account.jsx';
import AdminUsers from './pages/AdminUsers.jsx';

import AgentConsole from './pages/AgentConsole.jsx';
import CustomerSupport from './pages/CustomerSupport.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import { CAPABILITIES } from './constants/capabilities.js';
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
const KnowledgeBases = lazy(() => import('./pages/KnowledgeBases.jsx'));
const KnowledgeBaseDetail = lazy(() => import('./pages/KnowledgeBaseDetail.jsx'));

/** "/admin/knowledge/<id>" from the route pattern, for links from the list to a department. */
const pathWithDepartment = (pattern) => (departmentId) =>
  pattern.replace(':departmentId', encodeURIComponent(departmentId));
const hubDepartmentPath = pathWithDepartment(ROUTE_PATHS.KNOWLEDGE_HUB_DEPARTMENT);
const myDepartmentPath = pathWithDepartment(ROUTE_PATHS.MY_KNOWLEDGE_DEPARTMENT);

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
            <Route
              path={ROUTE_PATHS.MY_KNOWLEDGE}
              element={<KnowledgeBases scope="mine" detailPathOf={myDepartmentPath} />}
            />
            <Route
              path={ROUTE_PATHS.MY_KNOWLEDGE_DEPARTMENT}
              element={
                <KnowledgeBaseDetail listPath={ROUTE_PATHS.MY_KNOWLEDGE} listLabel="My department's knowledge base" />
              }
            />
            <Route path={ROUTE_PATHS.LEAVE} element={<LeaveCenter />}>
              <Route index element={<MyLeavePanel />} />
              <Route path={ROUTE_PATHS.LEAVE_CALENDAR} element={<LeaveCalendarPanel />} />
              <Route path={ROUTE_PATHS.LEAVE_APPROVALS} element={<ApprovalsPanel />} />
              <Route element={<CapabilityRoute capability={CAPABILITIES.MANAGE_WORKFORCE} />}>
                <Route path={ROUTE_PATHS.LEAVE_ADMIN} element={<LeaveAdministrationPanel />} />
              </Route>
            </Route>

            <Route element={<CapabilityRoute capability={CAPABILITIES.USE_SUPPORT_CHAT} />}>
              <Route path={ROUTE_PATHS.SUPPORT} element={<CustomerSupport />} />
            </Route>

            <Route element={<CapabilityRoute capability={CAPABILITIES.STAFF_SUPPORT} />}>
              <Route path={ROUTE_PATHS.CONSOLE} element={<AgentConsole />} />
              <Route path={ROUTE_PATHS.ORGANISATION} element={<OrgDirectory />} />
            </Route>

            <Route element={<CapabilityRoute capability={CAPABILITIES.MANAGE_WORKFORCE} />}>
              <Route path={ROUTE_PATHS.ONBOARDING} element={<PeopleOnboarding />} />
              <Route path={ROUTE_PATHS.WORKPLACE} element={<WorkplaceSetup />} />
            </Route>

            <Route element={<CapabilityRoute capability={CAPABILITIES.MANAGE_USERS} />}>
              <Route path={ROUTE_PATHS.ADMIN_USERS} element={<AdminUsers />} />
            </Route>
            <Route element={<CapabilityRoute capability={CAPABILITIES.VIEW_AGENT_TELEMETRY} />}>
              <Route path={ROUTE_PATHS.AGENT_TELEMETRY} element={<AgentTelemetry />} />
            </Route>
            <Route element={<CapabilityRoute capability={CAPABILITIES.MANAGE_COMPANY_SETTINGS} />}>
              <Route path={ROUTE_PATHS.COMPANY} element={<CompanySettings />} />
            </Route>
            <Route element={<CapabilityRoute capability={CAPABILITIES.MANAGE_KNOWLEDGE_BASES} />}>
              <Route
                path={ROUTE_PATHS.KNOWLEDGE_HUB}
                element={<KnowledgeBases scope="hub" detailPathOf={hubDepartmentPath} />}
              />
              <Route
                path={ROUTE_PATHS.KNOWLEDGE_HUB_DEPARTMENT}
                element={<KnowledgeBaseDetail listPath={ROUTE_PATHS.KNOWLEDGE_HUB} listLabel="Departments & Agents" />}
              />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
