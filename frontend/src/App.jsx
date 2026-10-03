/**
 * Route table.
 *
 *   /           -> redirects to /dashboard (which redirects to /login when signed out)
 *   /login      -> Login      (signed-out users only)
 *   /signup     -> Signup     (signed-out users only)
 *   /dashboard  -> Dashboard  (signed-in users only)
 *   anything else -> redirects to /
 */

import { Navigate, Route, Routes } from 'react-router';
import { ProtectedRoute, PublicOnlyRoute } from './components/RouteGuards.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Dashboard from './pages/Dashboard.jsx';
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
        <Route path={ROUTE_PATHS.DASHBOARD} element={<Dashboard />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
