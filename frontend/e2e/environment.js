/**
 * Shared settings for the browser tests: where the frontend and the test backend listen, and the
 * accounts global setup creates. Ports avoid the dev servers (5173, 5000) so both can run at once.
 */

export const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 5174);
export const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 5065);
export const FRONTEND_ORIGIN = `http://localhost:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

export const PASSWORD = 'Valid#Pass2026';

/** Created by global setup. The admin is the backend's bootstrap email. */
export const ACCOUNTS = Object.freeze({
  admin: { name: 'Avery Admin', email: 'admin@example.com' },
  hr: { name: 'Hema Rao', email: 'hema.hr@example.com' },
  customer: { name: 'Cyrus Mehta', email: 'cyrus@example.com' },
});

export const DEPARTMENT_NAME = 'Engineering';

/** An employee (with a profile, unlike the accounts above), onboarded by global setup the way HR does it. */
export const EMPLOYEE = Object.freeze({ name: 'Esha Iyer', email: 'esha.iyer@example.com' });
