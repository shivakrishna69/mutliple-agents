/**
 * Dashboard: the landing page after signup or login. It shows who is signed in and
 * provides sign-out. ProtectedRoute (App.jsx) guarantees an authenticated session before
 * this renders.
 *
 * Sign-out revokes the session on the server. If that request fails (network down, server
 * error) the user stays signed in and sees an error banner, because pretending to sign out
 * while the session cookie is still valid would leave the account open on this device.
 * On success, ProtectedRoute sees the signed-out state and redirects to /login.
 */

import { useState } from 'react';
import { ApiError } from '../api/authApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import { API_MESSAGES, BANNER_TITLES } from '../constants/messages.js';

export default function Dashboard() {
  const { currentUser, signOut } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(null);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
    } catch (signOutFailure) {
      setSignOutError({
        message: signOutFailure instanceof ApiError ? signOutFailure.message : API_MESSAGES.UNEXPECTED_SERVER_ERROR,
        requestId: signOutFailure instanceof ApiError && signOutFailure.status >= 500 ? signOutFailure.requestId : null,
      });
      setIsSigningOut(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-12 sm:px-6">
      {signOutError && (
        <ErrorBanner
          title={BANNER_TITLES.SIGN_OUT_FAILED}
          message={signOutError.message}
          requestId={signOutError.requestId}
          onDismiss={() => setSignOutError(null)}
        />
      )}
      <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-8">
        <div>
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">Welcome, {currentUser.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Signed in as {currentUser.email} · <span className="capitalize">{currentUser.role}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={isSigningOut}
          aria-busy={isSigningOut}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSigningOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </main>
  );
}
