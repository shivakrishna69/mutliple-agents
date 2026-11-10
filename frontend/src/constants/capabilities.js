/**
 * Capability names; mirrors backend constants/accessRoles.js CAPABILITIES. The signed-in user's
 * capabilities come from the server (GET /api/auth/me → user.capabilities), so which role may do
 * what is decided there and only there: the browser just asks "may this person do X?"
 * (auth/capabilities.js) to choose what to show. The backend authorises every request again.
 */
export const CAPABILITIES = Object.freeze({
  MANAGE_WORKFORCE: 'manage_workforce',
  READ_EMPLOYEE_DIRECTORY: 'read_employee_directory',
  MANAGE_PAYSLIPS: 'manage_payslips',
  MANAGE_COMPENSATION: 'manage_compensation',
  READ_OFFERS: 'read_offers',
  MANAGE_OFFERS: 'manage_offers',
  MANAGE_USERS: 'manage_users',
  ASSIGN_ADMIN_ROLE: 'assign_admin_role',
  READ_COMPANY_SETTINGS: 'read_company_settings',
  MANAGE_COMPANY_SETTINGS: 'manage_company_settings',
  VIEW_SYSTEM_HEALTH: 'view_system_health',
  VIEW_AGENT_TELEMETRY: 'view_agent_telemetry',
  STAFF_SUPPORT: 'staff_support',
  MANAGE_KNOWLEDGE_BASES: 'manage_knowledge_bases',
  USE_SUPPORT_CHAT: 'use_support_chat',
  ASK_DEPARTMENT_AGENTS: 'ask_department_agents',
  USE_TASK_BOARDS: 'use_task_boards',
  MANAGE_ALL_TASK_BOARDS: 'manage_all_task_boards',
});
