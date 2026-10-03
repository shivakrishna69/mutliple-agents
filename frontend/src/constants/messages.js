/**
 * User-facing text for the auth screens. Components reference these constants
 * instead of writing strings inline, so wording is reviewed in one place.
 */

import { USER_FIELD_LIMITS } from './validation.js';

export const FORM_MESSAGES = Object.freeze({
  NAME_REQUIRED: 'Enter your name.',
  NAME_TOO_LONG: `Name must be at most ${USER_FIELD_LIMITS.NAME_MAX_LENGTH} characters.`,
  EMAIL_REQUIRED: 'Enter your email address.',
  EMAIL_INVALID: 'Enter a valid email address, like name@example.com.',
  EMAIL_TOO_LONG: `Email must be at most ${USER_FIELD_LIMITS.EMAIL_MAX_LENGTH} characters.`,
  PASSWORD_REQUIRED: 'Enter your password.',
  PASSWORD_REQUIREMENTS_NOT_MET: 'Password does not meet all the requirements below.',
  PASSWORD_TOO_LONG: `Password is too long (maximum ${USER_FIELD_LIMITS.PASSWORD_MAX_BYTES} bytes; some characters count as more than one).`,
  CONFIRM_PASSWORD_REQUIRED: 'Re-enter your password.',
  PASSWORDS_DO_NOT_MATCH: 'Passwords do not match.',
});

export const API_MESSAGES = Object.freeze({
  NETWORK_UNAVAILABLE: 'We could not reach the server. Check your internet connection and try again.',
  SERVER_UNAVAILABLE: 'The server is not responding right now. Please try again in a moment.',
  REQUEST_TIMED_OUT: 'The request took too long. Please try again.',
  UNEXPECTED_SERVER_ERROR: 'Something went wrong on our side. Please try again in a moment.',
  UNEXPECTED_RESPONSE: 'The server sent an unexpected response. Please try again.',
  INVALID_CREDENTIALS: 'The email or password you entered is incorrect.',
});

export const SESSION_MESSAGES = Object.freeze({
  CHECKING_SESSION: 'Checking your session…',
});

export const SOCKET_CLIENT_MESSAGES = Object.freeze({
  JOIN_TIMEOUT: 'The server did not confirm joining the conversation in time.',
  CONNECTION_FAILED: 'Live updates are unavailable right now. Retrying…',
});

export const BANNER_TITLES = Object.freeze({
  SIGNUP_FAILED: 'We could not create your account',
  LOGIN_FAILED: 'Sign-in failed',
  SIGN_OUT_FAILED: 'We could not sign you out',
});
