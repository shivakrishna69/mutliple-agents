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
  // Support console for staff (admins and agents) only.
  CONSOLE: '/console',
  // Support chat for customers.
  SUPPORT: '/support',
  // Profile and password, for every signed-in user.
  ACCOUNT: '/account',
  // User and role management, admins only.
  ADMIN_USERS: '/admin/users',
  // Workforce: every signed-in user (features need an employee profile; the backend decides).
  ATTENDANCE: '/attendance',
  PAYROLL: '/payroll',
  ANALYTICS: '/analytics',
  // Organisation directory, staff only (the backend restricts /api/org to admins and agents).
  ORGANISATION: '/organisation',
  // Company name, employee ID format and email domain, admins only.
  COMPANY: '/admin/company',
  // Live agent telemetry console, admins only.
  AGENT_TELEMETRY: '/admin/telemetry',
  // Public payslip verification (no sign-in).
  VERIFY_PAYSLIP: '/verify/payslip',
  // Employee onboarding by invitation, HR and admins.
  ONBOARDING: '/people/onboarding',
  // Offices, holidays and employees' base offices, HR and admins.
  WORKPLACE: '/workplace',
  // Leave, with a tab per address. The backend's emails link to /leave and /leave/approvals
  // (backend/services/leaveRequestEmails.js LEAVE_APP_PATHS), so those two must not move.
  LEAVE: '/leave',
  LEAVE_CALENDAR: '/leave/calendar',
  LEAVE_APPROVALS: '/leave/approvals',
  // Leave administration (policies, balances, payroll export), HR and admins.
  LEAVE_ADMIN: '/leave/admin',
  // Department knowledge bases: every department's for admins (management), and the ones a person
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

/** Roles allowed into the support console; mirrors backend services/conversationAccess.js STAFF_ROLES. */
export const STAFF_ROLES = Object.freeze([USER_ROLES.ADMIN, USER_ROLES.AGENT]);

/**
 * Roles with organisation-wide HR access (people, payroll, analytics, reviews); mirrors backend
 * services/workforceAccess.js WORKFORCE_ADMIN_ROLES. Only decides what to show: the backend enforces it.
 */
export const WORKFORCE_ADMIN_ROLES = Object.freeze([USER_ROLES.ADMIN, USER_ROLES.HR]);

/**
 * What each role can do, shown wherever a role is chosen or displayed. `pluralLabel` names a group
 * of users ("Agents", "HR"); `assignmentPhrase` completes "<name> is now …".
 */
export const ROLE_DISPLAY = Object.freeze({
  admin: {
    label: 'Admin',
    pluralLabel: 'Admins',
    assignmentPhrase: 'an admin',
    description: 'Full access, including user management',
    badgeClassName: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  },
  agent: {
    label: 'Agent',
    pluralLabel: 'Agents',
    assignmentPhrase: 'an agent',
    description: 'Handles escalated conversations in the console',
    badgeClassName: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  },
  hr: {
    label: 'HR',
    pluralLabel: 'HR',
    assignmentPhrase: 'an HR team member',
    description: 'Manages employee records and documents',
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
    description: 'Uses their workspace: leave, attendance, payroll and the support chat',
    badgeClassName: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  },
});
