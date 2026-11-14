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
  // "Send me a confirmation link again" and "I forgot my password", together: each can send an email,
  // so one network cannot use them to mail many addresses (each address also has its own 60 s wait).
  ACCOUNT_EMAIL_REQUESTS_PER_CLIENT_IP: Object.freeze({ windowMs: ONE_HOUR_MS, maxRequests: 20 }),
  // Opening emailed links (confirm email, check and use a reset link): enough for a person, too few
  // to scan the token space.
  ACCOUNT_LINK_USES_PER_CLIENT_IP: Object.freeze({ windowMs: FIFTEEN_MINUTES_MS, maxRequests: 30 }),
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
  // Tax estimates are cheap but carry no reason to be called in bulk.
  TAX_ESTIMATES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 30 }),
  // Payslip generation renders a PDF in a browser; a month's run for a team stays within this.
  PAYSLIP_GENERATIONS_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 60 }),
  // Offer calculations (each preview renders a PDF) and dispatches (each sends an email).
  OFFER_CALCULATIONS_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 30 }),
  OFFER_DISPATCHES_PER_USER: Object.freeze({ windowMs: 15 * 60 * 1000, maxRequests: 30 }),
  // Offer CSVs (each row is checked and its salary structure computed) and bulk sends (up to
  // ONBOARDING_SETTINGS.BULK_SEND_MAX letters each).
  OFFER_IMPORTS_PER_USER: Object.freeze({ windowMs: 10 * 60 * 1000, maxRequests: 20 }),
  OFFER_BULK_SENDS_PER_USER: Object.freeze({ windowMs: 15 * 60 * 1000, maxRequests: 5 }),
  // Knowledge base uploads (each is read and indexed in the background) and other changes.
  KNOWLEDGE_UPLOADS_PER_USER: Object.freeze({ windowMs: 15 * 60 * 1000, maxRequests: 60 }),
  KNOWLEDGE_WRITES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 60 }),
  // Public verification: enough for a verifier, too few to scan the ID space.
  PAYSLIP_VERIFICATIONS_PER_CLIENT_IP: Object.freeze({ windowMs: 60 * 1000, maxRequests: 20 }),
  // OKR writes: progress sliders can fire often (clients should debounce); this stops runaway loops.
  OKR_WRITES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 120 }),
  // Workplace setup (offices, weekly offs, holidays): plenty for entering a year of holidays at once.
  WORKPLACE_SETUP_WRITES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 60 }),
  // HR leave changes (types, settings, adjustments, encashments, job runs).
  LEAVE_ADMIN_WRITES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 60 }),
  // Leave requests and decisions: a manager clearing a queue stays within this; a script does not.
  LEAVE_REQUEST_WRITES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 60 }),
  // The leave assistant: each question costs model calls; a person asks a few a minute at most.
  LEAVE_ASSISTANT_MESSAGES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 10 }),
  // Questions to department agents (each one is a model call); the daily quota is separate
  // (AGENT_DAILY_QUESTION_LIMIT).
  AGENT_QUESTIONS_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 10 }),
  // Feedback, clearing conversations, and a lead's work in the Questions Inbox.
  AGENT_CHAT_WRITES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 60 }),
  // Messages to the NSK assistant (each costs several model calls); the daily quota is separate
  // (NSK_DAILY_MESSAGE_LIMIT). Deleting sessions is a light write.
  NSK_MESSAGES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 10 }),
  NSK_WRITES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 60 }),
  // Creating and changing tasks, sprints and comments (a board drag is one change).
  TASK_WRITES_PER_USER: Object.freeze({ windowMs: 60 * 1000, maxRequests: 120 }),
  // Invitations send email: generous for onboarding a batch, low enough to stop mail abuse.
  INVITATION_SENDS_PER_USER: Object.freeze({ windowMs: 10 * 60 * 1000, maxRequests: 60 }),
  // Employee imports: each upload checks up to thousands of rows; a few corrections in a row are normal.
  EMPLOYEE_IMPORT_UPLOADS_PER_USER: Object.freeze({ windowMs: 10 * 60 * 1000, maxRequests: 20 }),
  // Public invite links: enough to open a link and set a password a few times, too few to scan tokens.
  INVITATION_LOOKUPS_PER_CLIENT_IP: Object.freeze({ windowMs: FIFTEEN_MINUTES_MS, maxRequests: 30 }),
});
