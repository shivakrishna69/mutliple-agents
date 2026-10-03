/**
 * Session state for the whole app.
 *
 * The session itself lives in HttpOnly cookies that JavaScript cannot read, so this context
 * holds only what the UI needs: whether the user is signed in, their public profile, and the
 * CSRF token for state-changing requests. Nothing is written to localStorage or
 * sessionStorage; a page reload asks the server again (GET /api/auth/me).
 *
 * Lifecycle:
 *   1. Mount: status is CHECKING while GET /me runs; route guards show a spinner meanwhile.
 *   2. The server answers: AUTHENTICATED with user and CSRF token, or UNAUTHENTICATED.
 *      If the server cannot be reached, the app falls back to UNAUTHENTICATED; the login form
 *      will then show the connection error when the user tries to sign in.
 *   3. Login / signup call `establishSession` with the response, switching to AUTHENTICATED.
 *   4. `signOut` revokes the session on the server, then switches to UNAUTHENTICATED. If the
 *      server cannot be reached the error is rethrown and the state is left unchanged, because
 *      claiming "signed out" while the session cookie is still valid would be misleading.
 *   5. `markSessionEnded` switches to UNAUTHENTICATED when the server reports over the socket
 *      that the session ended (hooks/useSocket.js).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { requestCurrentSession, requestLogout } from '../api/authApi.js';

export const AUTH_STATUS = Object.freeze({
  CHECKING: 'checking',
  AUTHENTICATED: 'authenticated',
  UNAUTHENTICATED: 'unauthenticated',
});

const SIGNED_OUT_STATE = Object.freeze({ authStatus: AUTH_STATUS.UNAUTHENTICATED, currentUser: null, csrfToken: null });

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [sessionState, setSessionState] = useState({ authStatus: AUTH_STATUS.CHECKING, currentUser: null, csrfToken: null });

  // Restore the session on page load. The request is aborted if the provider unmounts.
  useEffect(() => {
    const sessionCheckController = new AbortController();

    requestCurrentSession({ signal: sessionCheckController.signal })
      .then((currentSession) => {
        if (sessionCheckController.signal.aborted) return;
        setSessionState(
          currentSession
            ? { authStatus: AUTH_STATUS.AUTHENTICATED, currentUser: currentSession.user, csrfToken: currentSession.csrfToken }
            : SIGNED_OUT_STATE,
        );
      })
      .catch(() => {
        if (sessionCheckController.signal.aborted) return;
        setSessionState(SIGNED_OUT_STATE);
      });

    return () => sessionCheckController.abort();
  }, []);

  /** Records a session returned by signup or login. */
  const establishSession = useCallback(({ user, csrfToken }) => {
    setSessionState({ authStatus: AUTH_STATUS.AUTHENTICATED, currentUser: user, csrfToken });
  }, []);

  /** Revokes the session on the server, then clears local state. Rejects with ApiError on failure. */
  const signOut = useCallback(async () => {
    await requestLogout(sessionState.csrfToken);
    setSessionState(SIGNED_OUT_STATE);
  }, [sessionState.csrfToken]);

  /**
   * Records that the server ended the session (expired, logged out elsewhere, revoked), as
   * reported by the real-time connection. No request is sent: the session is already invalid
   * server-side. Route guards then redirect to /login.
   */
  const markSessionEnded = useCallback(() => {
    setSessionState(SIGNED_OUT_STATE);
  }, []);

  const contextValue = useMemo(
    () => ({ ...sessionState, establishSession, signOut, markSessionEnded }),
    [sessionState, establishSession, signOut, markSessionEnded],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

/** Access the session state. Must be called inside <AuthProvider>. */
export function useAuth() {
  const authContextValue = useContext(AuthContext);
  if (authContextValue === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return authContextValue;
}
