/**
 * Auth endpoints: signup and email confirmation, login, current session, logout, password change,
 * forgotten password, and the rules and numbers the sign-in screens show. Transport, CSRF header,
 * and error mapping live in api/httpClient.js.
 *
 * Every text the screens show comes from these answers: `message` on success, ApiError.message,
 * .fieldErrors, .code and .context on failure (written by the backend, constants/messages.js).
 */

import { API_MESSAGES } from '../constants/messages.js';
import { ApiError, HTTP_STATUS_UNAUTHORIZED, sendApiRequest } from './httpClient.js';

// Re-exported so existing imports of ApiError from this module keep working.
export { ApiError };

export const AUTH_ENDPOINTS = Object.freeze({
  SIGNUP: '/api/auth/signup',
  VERIFY_EMAIL: '/api/auth/verify-email',
  RESEND_VERIFICATION: '/api/auth/verify-email/resend',
  LOGIN: '/api/auth/login',
  CURRENT_SESSION: '/api/auth/me',
  LOGOUT: '/api/auth/logout',
  CHANGE_PASSWORD: '/api/auth/password',
  FORGOT_PASSWORD: '/api/auth/password/forgot',
  RESET_PASSWORD: '/api/auth/password/reset',
  PASSWORD_POLICY: '/api/auth/password-policy',
  OPTIONS: '/api/auth/options',
});

/** Codes the backend sends with errors the screens react to (backend/services/accountEmailFlows.js). */
export const AUTH_ERROR_CODES = Object.freeze({
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  EMAIL_COOLDOWN: 'EMAIL_COOLDOWN',
  VERIFICATION_LINK_INVALID: 'VERIFICATION_LINK_INVALID',
  VERIFICATION_CODE_INVALID: 'VERIFICATION_CODE_INVALID',
  RESET_LINK_INVALID: 'RESET_LINK_INVALID',
});

/** A request whose answer is `{ message, data }`; resolves to `{ message, ...data }`. */
async function sendForMessage(method, endpointPath, { requestPayload, signal } = {}) {
  const { responseData, responseMessage, httpStatus } = await sendApiRequest({
    method,
    endpointPath,
    requestPayload,
    callerSignal: signal,
  });
  if (!responseMessage) throw new ApiError({ message: API_MESSAGES.UNEXPECTED_RESPONSE, status: httpStatus });
  return { message: responseMessage, ...(responseData ?? {}) };
}

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
 * Creates an account that must confirm its email before signing in; the backend emails a code and
 * a link. No session is started.
 * @param {{ firstName: string, lastName: string, email: string, phoneNumber: string, password: string,
 *   confirmPassword: string, acceptTerms: boolean }} signupDetails
 * @param {{ signal?: AbortSignal }} [requestOptions]
 * @returns {Promise<{ message: string, email: string, resendAfterSeconds: number, codeDigits: number }>}
 */
export function requestSignup(signupDetails, { signal } = {}) {
  return sendForMessage('POST', AUTH_ENDPOINTS.SIGNUP, { requestPayload: signupDetails, signal });
}

/**
 * Confirms an email with `{ token }` (the emailed link) or `{ email, code }` (the emailed code), and
 * signs the person in. Resolves to `{ message, user, csrfToken }`.
 */
export async function requestEmailConfirmation(confirmation, { signal } = {}) {
  const { responseData, responseMessage, httpStatus } = await sendApiRequest({
    method: 'POST',
    endpointPath: AUTH_ENDPOINTS.VERIFY_EMAIL,
    requestPayload: confirmation,
    callerSignal: signal,
  });
  return { message: responseMessage, ...extractSessionPayload({ responseData, httpStatus }) };
}

/** A new confirmation email. Resolves to `{ message, resendAfterSeconds }`. */
export function requestVerificationEmail(email, { signal } = {}) {
  return sendForMessage('POST', AUTH_ENDPOINTS.RESEND_VERIFICATION, { requestPayload: { email }, signal });
}

/** A password reset email. Resolves to `{ message, resendAfterSeconds, linkValidMinutes }`. */
export function requestPasswordResetEmail(email, { signal } = {}) {
  return sendForMessage('POST', AUTH_ENDPOINTS.FORGOT_PASSWORD, { requestPayload: { email }, signal });
}

/** Whether a reset link still works. Resolves to `{ message, expiresAt }`. */
export function requestResetLinkStatus(token, { signal } = {}) {
  return sendForMessage('GET', `${AUTH_ENDPOINTS.RESET_PASSWORD}/${encodeURIComponent(token)}`, { signal });
}

/** Sets a new password with a reset link. Resolves to `{ message }`; nobody is signed in. */
export function requestPasswordReset({ token, password, confirmPassword }, { signal } = {}) {
  return sendForMessage('POST', AUTH_ENDPOINTS.RESET_PASSWORD, {
    requestPayload: { token, password, confirmPassword },
    signal,
  });
}

/** The password checklist and strength meter (backend/services/passwordPolicy.js). */
export function requestPasswordPolicy({ signal } = {}) {
  return sendForMessage('GET', AUTH_ENDPOINTS.PASSWORD_POLICY, { signal });
}

/** rememberedSessionDays, verificationCodeDigits and passwordResetLinkMinutes, as configured. */
export function requestAuthOptions({ signal } = {}) {
  return sendForMessage('GET', AUTH_ENDPOINTS.OPTIONS, { signal });
}

/**
 * Exchanges credentials for a session. Resolves to `{ user, csrfToken }`.
 * @param {{ email: string, password: string, rememberDevice?: boolean }} loginCredentials
 *   rememberDevice: stay signed in on this device for the configured number of days
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
