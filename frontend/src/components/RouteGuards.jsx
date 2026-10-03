/**
 * Layout routes that gate pages on the session state from AuthContext.
 * These control navigation only; real access control happens on the backend,
 * which verifies the session cookie on every protected request.
 * While the initial session check is running, both show a spinner instead of guessing,
 * so a signed-in user never sees the login page flash on reload.
 */

import { Navigate, Outlet } from 'react-router';
import { AUTH_STATUS, useAuth } from '../auth/AuthContext.jsx';
import { ROUTE_PATHS, STAFF_ROLES, USER_ROLES } from '../constants/routes.js';
import { SESSION_MESSAGES } from '../constants/messages.js';

function SessionCheckSpinner() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4" role="status" aria-live="polite">
      <svg className="h-8 w-8 animate-spin text-indigo-600" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
      </svg>
      <span className="sr-only">{SESSION_MESSAGES.CHECKING_SESSION}</span>
    </main>
  );
}

/** Renders the child route when signed in; otherwise redirects to /login. */
export function ProtectedRoute() {
  const { authStatus } = useAuth();
  if (authStatus === AUTH_STATUS.CHECKING) return <SessionCheckSpinner />;
  if (authStatus !== AUTH_STATUS.AUTHENTICATED) return <Navigate to={ROUTE_PATHS.LOGIN} replace />;
  return <Outlet />;
}

/**
 * Renders the child route only for signed-in staff (admin or agent). Customers are sent to the
 * dashboard; signed-out users to login. The backend enforces the same rule on every staff route.
 */
export function StaffRoute() {
  const { authStatus, currentUser } = useAuth();
  if (authStatus === AUTH_STATUS.CHECKING) return <SessionCheckSpinner />;
  if (authStatus !== AUTH_STATUS.AUTHENTICATED) return <Navigate to={ROUTE_PATHS.LOGIN} replace />;
  if (!STAFF_ROLES.includes(currentUser?.role)) return <Navigate to={ROUTE_PATHS.DASHBOARD} replace />;
  return <Outlet />;
}

/** Renders the child route only for signed-in customers; staff are sent to the dashboard. */
export function CustomerRoute() {
  const { authStatus, currentUser } = useAuth();
  if (authStatus === AUTH_STATUS.CHECKING) return <SessionCheckSpinner />;
  if (authStatus !== AUTH_STATUS.AUTHENTICATED) return <Navigate to={ROUTE_PATHS.LOGIN} replace />;
  if (currentUser?.role !== USER_ROLES.CUSTOMER) return <Navigate to={ROUTE_PATHS.DASHBOARD} replace />;
  return <Outlet />;
}

/** Renders the child route only for signed-in admins; everyone else is sent to the dashboard. */
export function AdminRoute() {
  const { authStatus, currentUser } = useAuth();
  if (authStatus === AUTH_STATUS.CHECKING) return <SessionCheckSpinner />;
  if (authStatus !== AUTH_STATUS.AUTHENTICATED) return <Navigate to={ROUTE_PATHS.LOGIN} replace />;
  if (currentUser?.role !== USER_ROLES.ADMIN) return <Navigate to={ROUTE_PATHS.DASHBOARD} replace />;
  return <Outlet />;
}

/** Renders the child route when signed out; a signed-in user is sent to /dashboard instead. */
export function PublicOnlyRoute() {
  const { authStatus } = useAuth();
  if (authStatus === AUTH_STATUS.CHECKING) return <SessionCheckSpinner />;
  if (authStatus === AUTH_STATUS.AUTHENTICATED) return <Navigate to={ROUTE_PATHS.DASHBOARD} replace />;
  return <Outlet />;
}
