/** Client-side route paths. Navigation code references these instead of string literals. */
export const ROUTE_PATHS = Object.freeze({
  LOGIN: '/login',
  SIGNUP: '/signup',
  // Signed out. The backend's account emails link to /verify-email/:token, /reset-password/:token,
  // /login and /forgot-password (backend constants/validation.js ACCOUNT_LINK_PATHS): keep them.
  CHECK_EMAIL: '/check-email',
  VERIFY_EMAIL: '/verify-email/:token',
  FORGOT_PASSWORD: '/forgot-password',
  RESET_PASSWORD_WITH_CODE: '/reset-password',
  RESET_PASSWORD: '/reset-password/:token',
  DASHBOARD: '/dashboard',
  // Support console (STAFF_SUPPORT).
  CONSOLE: '/console',
  // Support chat (USE_SUPPORT_CHAT).
  SUPPORT: '/support',
  // Profile and password, for every signed-in user.
  ACCOUNT: '/account',
  // User and role management (MANAGE_USERS).
  ADMIN_USERS: '/admin/users',
  // Workforce: every signed-in user (features need an employee profile; the backend decides).
  ATTENDANCE: '/attendance',
  PAYROLL: '/payroll',
  ANALYTICS: '/analytics',
  // Organisation directory (STAFF_SUPPORT).
  ORGANISATION: '/organisation',
  // Company name, employee ID format and email domain (MANAGE_COMPANY_SETTINGS).
  COMPANY: '/admin/company',
  // Live agent telemetry console (VIEW_AGENT_TELEMETRY).
  AGENT_TELEMETRY: '/admin/telemetry',
  // Public payslip verification (no sign-in).
  VERIFY_PAYSLIP: '/verify/payslip',
  // Employee onboarding by invitation (MANAGE_WORKFORCE).
  ONBOARDING: '/people/onboarding',
  // Offices, holidays and employees' base offices (MANAGE_WORKFORCE).
  WORKPLACE: '/workplace',
  // Leave, with a tab per address. The backend's emails link to /leave and /leave/approvals
  // (backend/services/leaveRequestEmails.js LEAVE_APP_PATHS), so those two must not move.
  LEAVE: '/leave',
  LEAVE_CALENDAR: '/leave/calendar',
  LEAVE_APPROVALS: '/leave/approvals',
  // Leave administration: policies, balances, payroll export (MANAGE_WORKFORCE).
  LEAVE_ADMIN: '/leave/admin',
  // Department knowledge bases: every department's with MANAGE_KNOWLEDGE_BASES, and the ones a person
  // heads or leads (self-service). The same pages; the backend decides what each person sees.
  KNOWLEDGE_HUB: '/admin/knowledge',
  KNOWLEDGE_HUB_DEPARTMENT: '/admin/knowledge/:departmentId',
  MY_KNOWLEDGE: '/knowledge',
  MY_KNOWLEDGE_DEPARTMENT: '/knowledge/:departmentId',
  // Public page behind the emailed invitation link.
  ACCEPT_INVITATION: '/invite/:token',
});

/** Account roles; mirrors backend constants ROLES. */
export const USER_ROLES = Object.freeze({
  ADMIN: 'admin',
  HR: 'hr',
  FINANCE: 'finance',
  IT_ADMIN: 'it_admin',
  AGENT: 'agent',
  EMPLOYEE: 'employee',
});

/**
 * How each role is shown: its badge colour and phrases. Labels and descriptions match backend
 * constants/accessRoles.js ROLE_DEFINITIONS (which the server also sends where roles are chosen);
 * they are kept here so a badge never waits for a request. What a role may do is not here: it comes
 * from the server as capabilities (auth/capabilities.js). `pluralLabel` names a group of users;
 * `assignmentPhrase` completes "<name> is now …".
 */
export const ROLE_DISPLAY = Object.freeze({
  admin: {
    label: 'Admin',
    pluralLabel: 'Admins',
    assignmentPhrase: 'an admin',
    description: 'Everything, including users, roles and company settings',
    badgeClassName: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  },
  agent: {
    label: 'Support Agent',
    pluralLabel: 'Support Agents',
    assignmentPhrase: 'a support agent',
    description: 'The support console',
    badgeClassName: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  },
  hr: {
    label: 'HR',
    pluralLabel: 'HR',
    assignmentPhrase: 'an HR team member',
    description: 'People, onboarding, leave, attendance, workplace and payroll',
    badgeClassName: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  },
  finance: {
    label: 'Finance & Payroll',
    pluralLabel: 'Finance & Payroll',
    assignmentPhrase: 'in Finance & Payroll',
    description: 'Payslips, salary structures and offers (read), the employee directory',
    badgeClassName: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  },
  it_admin: {
    label: 'IT Administrator',
    pluralLabel: 'IT Administrators',
    assignmentPhrase: 'an IT administrator',
    description: 'User accounts, company settings and system health; no HR or salary data',
    badgeClassName: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  },
  employee: {
    label: 'Employee',
    pluralLabel: 'Employees',
    assignmentPhrase: 'an employee',
    description: 'Their own workspace: attendance, leave, payslips, support chat',
    badgeClassName: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  },
});
