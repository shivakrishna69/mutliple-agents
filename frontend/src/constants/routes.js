/** Client-side route paths. Navigation code references these instead of string literals. */
export const ROUTE_PATHS = Object.freeze({
  LOGIN: '/login',
  SIGNUP: '/signup',
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
  // Live agent telemetry console, admins only.
  AGENT_TELEMETRY: '/admin/telemetry',
  // Public payslip verification (no sign-in).
  VERIFY_PAYSLIP: '/verify/payslip',
  // Employee onboarding by invitation, HR and admins.
  ONBOARDING: '/people/onboarding',
  // Public page behind the emailed invitation link.
  ACCEPT_INVITATION: '/invite/:token',
});

/** Account roles; mirrors backend constants ROLES. */
export const USER_ROLES = Object.freeze({ ADMIN: 'admin', AGENT: 'agent', HR: 'hr', CUSTOMER: 'customer' });

/** Roles allowed into the support console; mirrors backend services/conversationAccess.js STAFF_ROLES. */
export const STAFF_ROLES = Object.freeze([USER_ROLES.ADMIN, USER_ROLES.AGENT]);

/**
 * What each role can do, shown wherever a role is chosen or displayed. `pluralLabel` names a group
 * of users ("Agents", "HR"); `assignmentPhrase` completes "<name> is now …".
 */
export const ROLE_DISPLAY = Object.freeze({
  admin: { label: 'Admin', pluralLabel: 'Admins', assignmentPhrase: 'an admin', description: 'Full access, including user management', badgeClassName: 'bg-violet-50 text-violet-700 ring-violet-600/20' },
  agent: { label: 'Agent', pluralLabel: 'Agents', assignmentPhrase: 'an agent', description: 'Handles escalated conversations in the console', badgeClassName: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
  hr: { label: 'HR', pluralLabel: 'HR', assignmentPhrase: 'an HR team member', description: 'Manages employee records and documents', badgeClassName: 'bg-amber-50 text-amber-800 ring-amber-600/20' },
  customer: { label: 'Customer', pluralLabel: 'Customers', assignmentPhrase: 'a customer', description: 'Chats with support', badgeClassName: 'bg-slate-100 text-slate-700 ring-slate-500/20' },
});
