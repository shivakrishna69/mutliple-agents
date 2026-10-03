/**
 * Request budgets for the public auth endpoints.
 *
 *   LOGIN_PER_CLIENT_IP          caps total login attempts from one IP, whatever emails it tries
 *                                (slows credential stuffing across many accounts).
 *   LOGIN_PER_IP_AND_EMAIL       caps attempts against one account from one IP (slows password
 *                                guessing). It is keyed by IP *and* email, not email alone, so an
 *                                attacker cannot lock a real user out by failing logins for them.
 *   SIGNUP_PER_CLIENT_IP         caps account creation from one IP (slows mass fake signups).
 */

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export const RATE_LIMITS = Object.freeze({
  LOGIN_PER_CLIENT_IP: Object.freeze({ windowMs: FIFTEEN_MINUTES_MS, maxRequests: 30 }),
  LOGIN_PER_IP_AND_EMAIL: Object.freeze({ windowMs: FIFTEEN_MINUTES_MS, maxRequests: 5 }),
  SIGNUP_PER_CLIENT_IP: Object.freeze({ windowMs: ONE_HOUR_MS, maxRequests: 10 }),
});
