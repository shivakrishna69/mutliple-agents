/**
 * Access roles, what each one may do, and the job levels and employment types an employee record
 * carries: the single source of truth. Models, validators, controllers and the API that serves the
 * labels to the browser (GET /api/people/invitations/options, the signed-in user's capabilities)
 * all read from here.
 *
 * Two separate things, on purpose:
 *   access role   what a person may do in the software (User.role). Each role has a fixed set of
 *                 capabilities; code asks for a capability, never for a list of role names.
 *   job level     who a person is in the company (EmployeeProfile.organizationData.jobLevel): for
 *                 display and reports only. It grants nothing; approvals follow reporting lines
 *                 and department heads.
 *
 * Stored values are lowercase and never change once written (a role stored as "ADMIN" matches no
 * check). Labels can change freely.
 */

/** Access role values, as stored in User.role. */
export const ROLES = Object.freeze({
  ADMIN: 'admin',
  HR: 'hr',
  FINANCE: 'finance',
  IT_ADMIN: 'it_admin',
  AGENT: 'agent',
  EMPLOYEE: 'employee',
});

export const ROLE_CATEGORIES = Object.freeze({
  ADMINISTRATION: 'Administration',
  OPERATIONS: 'Operations',
  SUPPORT: 'Support',
  GENERAL: 'General',
});

/** Every access role, in the order it is offered, with its label, group and a one-line summary. */
export const ROLE_DEFINITIONS = Object.freeze([
  {
    value: ROLES.ADMIN,
    label: 'Admin',
    category: ROLE_CATEGORIES.ADMINISTRATION,
    description: 'Everything, including users, roles and company settings',
  },
  {
    value: ROLES.HR,
    label: 'HR',
    category: ROLE_CATEGORIES.OPERATIONS,
    description: 'People, onboarding, leave, attendance, workplace and payroll',
  },
  {
    value: ROLES.FINANCE,
    label: 'Finance & Payroll',
    category: ROLE_CATEGORIES.OPERATIONS,
    description: 'Payslips, salary structures and offers (read), the employee directory',
  },
  {
    value: ROLES.IT_ADMIN,
    label: 'IT Administrator',
    category: ROLE_CATEGORIES.OPERATIONS,
    description: 'User accounts, company settings and system health; no HR or salary data',
  },
  {
    value: ROLES.AGENT,
    label: 'Support Agent',
    category: ROLE_CATEGORIES.SUPPORT,
    description: 'The support console',
  },
  {
    value: ROLES.EMPLOYEE,
    label: 'Employee',
    category: ROLE_CATEGORIES.GENERAL,
    description: 'Their own workspace: attendance, leave, payslips, support chat',
  },
]);

/** Things a role may do. Code checks these (hasCapability), not role names. */
export const CAPABILITIES = Object.freeze({
  // People, onboarding, workplace, leave and attendance administration, vault, analytics.
  MANAGE_WORKFORCE: 'manage_workforce',
  READ_EMPLOYEE_DIRECTORY: 'read_employee_directory',
  MANAGE_PAYSLIPS: 'manage_payslips',
  // The CTC calculator and the compensation policy in the onboarding settings.
  MANAGE_COMPENSATION: 'manage_compensation',
  READ_OFFERS: 'read_offers',
  // Prepare, change, cancel and send offers (sending creates the employee), and the offer terms.
  MANAGE_OFFERS: 'manage_offers',
  MANAGE_USERS: 'manage_users',
  // Grant the admin role, or change an admin's role.
  ASSIGN_ADMIN_ROLE: 'assign_admin_role',
  READ_COMPANY_SETTINGS: 'read_company_settings',
  MANAGE_COMPANY_SETTINGS: 'manage_company_settings',
  VIEW_SYSTEM_HEALTH: 'view_system_health',
  VIEW_AGENT_TELEMETRY: 'view_agent_telemetry',
  // The support console and the organisation directory.
  STAFF_SUPPORT: 'staff_support',
  // Every department's knowledge base and agent (Departments & Agents). Heads and knowledge leads
  // manage their own department's without it.
  MANAGE_KNOWLEDGE_BASES: 'manage_knowledge_bases',
  // Ask for help in the support chat. Staff answer it rather than use it, so admins do not get it.
  USE_SUPPORT_CHAT: 'use_support_chat',
});

const C = CAPABILITIES;

/** Capabilities for people asking for help, never for the administrators who answer them. */
const REQUESTER_CAPABILITIES = Object.freeze([C.USE_SUPPORT_CHAT]);

/** What each role may do. A role not listed here may do nothing beyond its own workspace. */
export const ROLE_CAPABILITIES = Object.freeze({
  [ROLES.ADMIN]: Object.freeze(
    Object.values(CAPABILITIES).filter((capability) => !REQUESTER_CAPABILITIES.includes(capability)),
  ),
  [ROLES.HR]: Object.freeze([
    C.MANAGE_WORKFORCE,
    C.READ_EMPLOYEE_DIRECTORY,
    C.MANAGE_PAYSLIPS,
    C.MANAGE_COMPENSATION,
    C.READ_OFFERS,
    C.MANAGE_OFFERS,
    C.READ_COMPANY_SETTINGS,
  ]),
  [ROLES.FINANCE]: Object.freeze([C.READ_EMPLOYEE_DIRECTORY, C.MANAGE_PAYSLIPS, C.MANAGE_COMPENSATION, C.READ_OFFERS]),
  [ROLES.IT_ADMIN]: Object.freeze([
    C.READ_EMPLOYEE_DIRECTORY,
    C.MANAGE_USERS,
    C.READ_COMPANY_SETTINGS,
    C.MANAGE_COMPANY_SETTINGS,
    C.VIEW_SYSTEM_HEALTH,
    C.VIEW_AGENT_TELEMETRY,
  ]),
  [ROLES.AGENT]: Object.freeze([C.STAFF_SUPPORT]),
  [ROLES.EMPLOYEE]: Object.freeze([C.USE_SUPPORT_CHAT]),
});

/** True when `role` may do `capability`. An unknown role may do nothing. */
export function hasCapability(role, capability) {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

/** The capabilities of `role`, for the signed-in user's summary (the browser shows what they allow). */
export function capabilitiesOf(role) {
  return [...(ROLE_CAPABILITIES[role] ?? [])];
}

/**
 * The roles `assignerRole` may give someone in Users & roles (with their labels and groups): every
 * role for an admin; every role except admin for anyone else who manages users.
 */
export function assignableRoleDefinitionsFor(assignerRole) {
  if (!hasCapability(assignerRole, CAPABILITIES.MANAGE_USERS)) return [];
  const mayAssignAdmin = hasCapability(assignerRole, CAPABILITIES.ASSIGN_ADMIN_ROLE);
  return ROLE_DEFINITIONS.filter((definition) => mayAssignAdmin || definition.value !== ROLES.ADMIN);
}

/** Roles that can be given by invitation. Nobody becomes an admin by invitation. */
export const INVITABLE_ROLES = Object.freeze([ROLES.EMPLOYEE, ROLES.AGENT, ROLES.HR, ROLES.FINANCE, ROLES.IT_ADMIN]);

/** Which roles each inviter may grant: HR invites employees and support agents; admins all invitable roles. */
export const INVITATION_GRANTS = Object.freeze({
  [ROLES.ADMIN]: INVITABLE_ROLES,
  [ROLES.HR]: Object.freeze([ROLES.EMPLOYEE, ROLES.AGENT]),
});

export const JOB_LEVEL_CATEGORIES = Object.freeze({
  EXECUTIVE: 'Executive',
  MANAGEMENT: 'Management',
  STAFF: 'Staff',
});

/** Job levels, in order of seniority, as stored in EmployeeProfile.organizationData.jobLevel. */
export const JOB_LEVEL_DEFINITIONS = Object.freeze([
  { value: 'ceo', label: 'Chief Executive Officer (CEO)', category: JOB_LEVEL_CATEGORIES.EXECUTIVE },
  { value: 'cto', label: 'Chief Technology Officer (CTO)', category: JOB_LEVEL_CATEGORIES.EXECUTIVE },
  { value: 'coo', label: 'Chief Operating Officer (COO)', category: JOB_LEVEL_CATEGORIES.EXECUTIVE },
  { value: 'cfo', label: 'Chief Financial Officer (CFO)', category: JOB_LEVEL_CATEGORIES.EXECUTIVE },
  { value: 'vp', label: 'Vice President (VP)', category: JOB_LEVEL_CATEGORIES.EXECUTIVE },
  { value: 'head_of_department', label: 'Head of Department (HOD)', category: JOB_LEVEL_CATEGORIES.MANAGEMENT },
  { value: 'manager', label: 'Manager', category: JOB_LEVEL_CATEGORIES.MANAGEMENT },
  { value: 'team_lead', label: 'Team Lead', category: JOB_LEVEL_CATEGORIES.MANAGEMENT },
  { value: 'individual_contributor', label: 'Individual Contributor', category: JOB_LEVEL_CATEGORIES.STAFF },
]);

export const JOB_LEVELS = Object.freeze(JOB_LEVEL_DEFINITIONS.map((jobLevel) => jobLevel.value));
export const DEFAULT_JOB_LEVEL = 'individual_contributor';

/** Employment types, as stored in EmployeeProfile.organizationData.employmentType. Same access for all. */
export const EMPLOYMENT_TYPE_DEFINITIONS = Object.freeze([
  { value: 'full_time', label: 'Full-time' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'intern', label: 'Intern' },
]);

export const EMPLOYMENT_TYPES = Object.freeze(EMPLOYMENT_TYPE_DEFINITIONS.map((type) => type.value));
export const DEFAULT_EMPLOYMENT_TYPE = 'full_time';

/** The label of a role or job level value, for emails and summaries; the value itself when unknown. */
export const labelOfRole = (role) => ROLE_DEFINITIONS.find((definition) => definition.value === role)?.label ?? role;
