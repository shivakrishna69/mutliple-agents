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
 *
 *   anything else -> redirects to /
 *
 * Guards nest: ProtectedRoute (signed in) -> AppShell (layout) -> role guard -> page. Guards
 * only steer navigation; the backend authorises every request on its own.
 */

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

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={ROUTE_PATHS.DASHBOARD} replace />} />

      <Route element={<PublicOnlyRoute />}>
        <Route path={ROUTE_PATHS.LOGIN} element={<Login />} />
        <Route path={ROUTE_PATHS.SIGNUP} element={<Signup />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path={ROUTE_PATHS.DASHBOARD} element={<Dashboard />} />
          <Route path={ROUTE_PATHS.ACCOUNT} element={<Account />} />

          <Route element={<CustomerRoute />}>
            <Route path={ROUTE_PATHS.SUPPORT} element={<CustomerSupport />} />
          </Route>

          <Route element={<StaffRoute />}>
            <Route path={ROUTE_PATHS.CONSOLE} element={<AgentConsole />} />
          </Route>

          <Route element={<AdminRoute />}>
            <Route path={ROUTE_PATHS.ADMIN_USERS} element={<AdminUsers />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
