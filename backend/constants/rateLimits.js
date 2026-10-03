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
  // Customer chat: generous for a person typing, but stops a script from flooding the AI (each
  // message costs model calls) or the agents' queue.
  SUPPORT_MESSAGES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 15 }),
  // Document vault: uploads are buffered in memory (up to 10 MB each), so they are capped per user;
  // downloads are capped to slow bulk scraping by a compromised account.
  VAULT_UPLOADS_PER_USER: Object.freeze({ windowMs: 10 * 60 * 1000, maxRequests: 30 }),
  VAULT_DOWNLOADS_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 30 }),
  // Attendance: enough for a person retrying a weak GPS fix; stops a script sweeping coordinates to
  // map out the geofence boundary.
  ATTENDANCE_PUNCHES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 10 }),
  // Attendance regularization: each message costs model calls; a person needs only a few per request.
  REGULARIZATION_MESSAGES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 10 }),
});
