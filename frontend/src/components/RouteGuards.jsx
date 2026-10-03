/**
 * Layout routes that gate pages on the session state from AuthContext.
 * These control navigation only; real access control happens on the backend,
 * which verifies the session cookie on every protected request.
 * While the initial session check is running, both show a spinner instead of guessing,
 * so a signed-in user never sees the login page flash on reload.
 */

import { Navigate, Outlet } from 'react-router';
import { AUTH_STATUS, useAuth } from '../auth/AuthContext.jsx';
import { ROUTE_PATHS } from '../constants/routes.js';
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

/** Renders the child route when signed out; a signed-in user is sent to /dashboard instead. */
export function PublicOnlyRoute() {
  const { authStatus } = useAuth();
  if (authStatus === AUTH_STATUS.CHECKING) return <SessionCheckSpinner />;
  if (authStatus === AUTH_STATUS.AUTHENTICATED) return <Navigate to={ROUTE_PATHS.DASHBOARD} replace />;
  return <Outlet />;
}
