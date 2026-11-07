/**
 * Shared settings for the browser tests: where the frontend and the test backend listen, and the
 * accounts global setup creates. Ports avoid the dev servers (5173, 5000) so both can run at once.
 */

export const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 5174);
export const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 5065);
export const FRONTEND_ORIGIN = `http://localhost:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
/** The test backend's mail inbox: everything it emails, readable at GET /messages?to=<address>. */
export const MAIL_INBOX_PORT = Number(process.env.E2E_MAIL_INBOX_PORT ?? 5066);
export const MAIL_INBOX_URL = `http://127.0.0.1:${MAIL_INBOX_PORT}`;

export const PASSWORD = 'Valid#Pass2026';

/** Created by global setup. The admin is the backend's bootstrap email. */
export const ACCOUNTS = Object.freeze({
  admin: { name: 'Avery Admin', email: 'admin@example.com' },
  hr: { name: 'Hema Rao', email: 'hema.hr@example.com' },
  customer: { name: 'Cyrus Mehta', email: 'cyrus@example.com' },
});

/**
 * An account only the password-reset test uses, since that test changes its password. Its signup
 * email's cooldown is ended at the end of global setup, so the test can ask for a reset at once.
 */
export const RESET_ACCOUNT = Object.freeze({ name: 'Rohan Desai', email: 'rohan.desai@example.com' });

export const DEPARTMENT_NAME = 'Engineering';

/** An employee (with a profile, unlike the accounts above), onboarded by global setup the way HR does it. */
export const EMPLOYEE = Object.freeze({ name: 'Esha Iyer', email: 'esha.iyer@example.com' });

/**
 * A leave scenario ready to use: an employee at an office where every day is a working day, with
 * 5 days of Casual Leave, who reports to the manager. Sick Leave needs a supporting document.
 */
export const LEAVE_EMPLOYEE = Object.freeze({ name: 'Leela Nair', email: 'leela.nair@example.com' });
export const LEAVE_MANAGER = Object.freeze({ name: 'Manav Shah', email: 'manav.shah@example.com' });
export const LEAVE_EMPLOYEE_CASUAL_DAYS = 5;

/**
 * Another employee of the same manager and office, for the two-step approval test: Earned Leave
 * needs HR's approval after the manager's for any length of leave, and she has some.
 */
export const TWO_STEP_EMPLOYEE = Object.freeze({ name: 'Tara Pillai', email: 'tara.pillai@example.com' });
export const TWO_STEP_EARNED_DAYS = 3;

/**
 * The head of the department (set by global setup): manages its knowledge base from self-service
 * ("My department's knowledge base"). An employee account, so no portal switcher.
 */
export const KNOWLEDGE_HEAD = Object.freeze({ name: 'Kavya Menon', email: 'kavya.menon@example.com' });

/**
 * A second administrator for the Departments & Agents test, so its sign-in does not use up the main
 * admin's (5 sign-ins per account per 15 minutes, which the other specs already use).
 */
export const KNOWLEDGE_ADMIN = Object.freeze({ name: 'Kiran Rao', email: 'kiran.rao@example.com' });
