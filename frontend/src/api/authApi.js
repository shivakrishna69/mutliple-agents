/**
 * Auth endpoints: signup, login, current session, logout. Transport, CSRF header, and error
 * mapping live in api/httpClient.js.
 */

import { API_MESSAGES } from '../constants/messages.js';
import { ApiError, HTTP_STATUS_UNAUTHORIZED, sendApiRequest } from './httpClient.js';

// Re-exported so existing imports of ApiError from this module keep working.
export { ApiError };

export const AUTH_ENDPOINTS = Object.freeze({
  SIGNUP: '/api/auth/signup',
  LOGIN: '/api/auth/login',
  CURRENT_SESSION: '/api/auth/me',
  LOGOUT: '/api/auth/logout',
  CHANGE_PASSWORD: '/api/auth/password',
});

/**
 * Checks that a session response carries `{ user, csrfToken }` and returns exactly those.
 * Anything else means the backend and frontend disagree on the contract.
 */
function extractSessionPayload({ responseData, httpStatus }) {
  const hasUser = typeof responseData?.user === 'object' && responseData.user !== null;
  const hasCsrfToken = typeof responseData?.csrfToken === 'string' && responseData.csrfToken.length > 0;
  if (!hasUser || !hasCsrfToken) {
    throw new ApiError({ message: API_MESSAGES.UNEXPECTED_RESPONSE, status: httpStatus });
  }
  return { user: responseData.user, csrfToken: responseData.csrfToken };
}

/**
 * Creates an account and signs in. Resolves to `{ user, csrfToken }`; the session cookies are
 * set by the response.
 * @param {{ name: string, email: string, password: string }} signupDetails
 * @param {{ signal?: AbortSignal }} [requestOptions]
 */
export async function requestSignup(signupDetails, { signal } = {}) {
  const apiResponse = await sendApiRequest({
    method: 'POST',
    endpointPath: AUTH_ENDPOINTS.SIGNUP,
    requestPayload: signupDetails,
    callerSignal: signal,
  });
  return extractSessionPayload(apiResponse);
}

/**
 * Exchanges credentials for a session. Resolves to `{ user, csrfToken }`.
 * @param {{ email: string, password: string }} loginCredentials
 * @param {{ signal?: AbortSignal }} [requestOptions]
 */
export async function requestLogin(loginCredentials, { signal } = {}) {
  const apiResponse = await sendApiRequest({
    method: 'POST',
    endpointPath: AUTH_ENDPOINTS.LOGIN,
    requestPayload: loginCredentials,
    callerSignal: signal,
  });
  return extractSessionPayload(apiResponse);
}

/**
 * Asks the backend whether the browser holds a valid session (used on page load).
 * Resolves to `{ user, csrfToken }`, or to null when there is no valid session (401).
 * Other failures (network, 5xx) reject with ApiError so the caller can tell them apart from
 * "signed out".
 * @param {{ signal?: AbortSignal }} [requestOptions]
 */
export async function requestCurrentSession({ signal } = {}) {
  try {
    const apiResponse = await sendApiRequest({
      method: 'GET',
      endpointPath: AUTH_ENDPOINTS.CURRENT_SESSION,
      callerSignal: signal,
    });
    return extractSessionPayload(apiResponse);
  } catch (sessionError) {
    if (sessionError instanceof ApiError && sessionError.status === HTTP_STATUS_UNAUTHORIZED) return null;
    throw sessionError;
  }
}

/**
 * Changes the password. The backend revokes every other session and issues a fresh one for
 * this browser, so this resolves to the new `{ user, csrfToken }` (the old CSRF token stops working).
 * @param {{ currentPassword: string, newPassword: string }} passwordChange
 * @param {string} csrfToken  The current session's CSRF token.
 * @param {{ signal?: AbortSignal }} [requestOptions]
 */
export async function requestChangePassword(passwordChange, csrfToken, { signal } = {}) {
  const apiResponse = await sendApiRequest({
    method: 'POST',
    endpointPath: AUTH_ENDPOINTS.CHANGE_PASSWORD,
    requestPayload: passwordChange,
    csrfToken,
    callerSignal: signal,
  });
  return extractSessionPayload(apiResponse);
}

/**
 * Ends the session on the server (revokes it) and clears the cookies.
 * Resolves when the server confirms. A 401 also resolves, because it means the session had
 * already ended, which is the outcome the caller wanted.
 * @param {string} csrfToken  The current session's CSRF token.
 */
export async function requestLogout(csrfToken) {
  try {
    await sendApiRequest({
      method: 'POST',
      endpointPath: AUTH_ENDPOINTS.LOGOUT,
      requestPayload: {},
      csrfToken,
    });
  } catch (logoutError) {
    if (logoutError instanceof ApiError && logoutError.status === HTTP_STATUS_UNAUTHORIZED) return;
    throw logoutError;
  }
}
