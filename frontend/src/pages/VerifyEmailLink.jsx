/**
 * The page the confirmation link opens (/verify-email/:token): POST /api/auth/verify-email
 * { token } as soon as it loads.
 *
 *   confirmed   the person is signed in and goes to the dashboard
 *   refused     the server's message (used, expired or replaced link) and the ways on: type the
 *               code instead, or ask for a new email, on "check your email"
 *
 * A link works once, so the request is sent once per token even if the page renders twice (React's
 * development double-render, or a quick reload): the answer is kept per token for this page load.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, requestEmailConfirmation } from '../api/authApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import { API_MESSAGES, BANNER_TITLES } from '../constants/messages.js';
import { ROUTE_PATHS } from '../constants/routes.js';
import { usePublicAuthSettings } from '../hooks/usePublicAuthSettings.js';

const confirmationsByToken = new Map();

function confirmOnce(token) {
  if (!confirmationsByToken.has(token)) {
    confirmationsByToken.set(
      token,
      requestEmailConfirmation({ token }).then(
        (session) => ({ session, failure: null }),
        (failure) => ({
          session: null,
          failure: failure instanceof ApiError ? failure.message : API_MESSAGES.UNEXPECTED_SERVER_ERROR,
        }),
      ),
    );
  }
  return confirmationsByToken.get(token);
}

const linkButtonClass =
  'inline-flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

export default function VerifyEmailLink() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { establishSession } = useAuth();
  const { branding } = usePublicAuthSettings();
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    let isCurrent = true;
    confirmOnce(token).then(({ session, failure: refusal }) => {
      if (!isCurrent) return;
      if (session) {
        establishSession(session);
        navigate(ROUTE_PATHS.DASHBOARD, { replace: true });
      } else {
        setFailure(refusal);
      }
    });
    return () => {
      isCurrent = false;
    };
  }, [token, establishSession, navigate]);

  return (
    <AuthShell branding={branding} title={failure ? 'Confirm your email' : 'Confirming your email…'}>
      {failure ? (
        <div className="space-y-4">
          <ErrorBanner title={BANNER_TITLES.LINK_NOT_USABLE} message={failure} />
          <Link
            to={ROUTE_PATHS.CHECK_EMAIL}
            className={`${linkButtonClass} bg-brand-600 text-white shadow-lg shadow-brand-500/25 hover:bg-brand-500`}
          >
            Enter a code or get a new email
          </Link>
          <Link
            to={ROUTE_PATHS.LOGIN}
            className={`${linkButtonClass} border border-slate-200 text-slate-700 hover:bg-slate-50`}
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <p role="status" className="flex items-center gap-3 text-sm text-slate-600">
          <svg className="h-5 w-5 animate-spin text-brand-600" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
          </svg>
          Checking your link…
        </p>
      )}
    </AuthShell>
  );
}
