/**
 * Role-based access for routes that run after `protect` (which sets req.user).
 *
 *   router.get('/conversations', protect, requireStaff, listConversations);
 *
 * Roles come from the database on every request (protect reloads the user), so a role change
 * applies immediately. Failure is 403: the caller is signed in but not allowed.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { CAPABILITIES, hasCapability } from '../constants/accessRoles.js';
import { COMMON_MESSAGES, CONVERSATION_MESSAGES } from '../constants/messages.js';
import { isStaffRole } from '../services/conversationAccess.js';
import { sendError } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';

/**
 * Allows only roles with `capability` (constants/accessRoles.js); others get 403 with `refusalMessage`.
 *   router.use(protect, requireCapability(CAPABILITIES.MANAGE_USERS, ADMIN_MESSAGES.USER_MANAGERS_ONLY));
 */
export function requireCapability(capability, refusalMessage) {
  return function requireCapabilityMiddleware(req, res, next) {
    if (!hasCapability(req.user?.role, capability)) {
      logger.warn('Route refused: capability missing', {
        requestId: req.id,
        userId: req.user?.id,
        role: req.user?.role,
        capability,
        path: req.originalUrl,
      });
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, refusalMessage);
    }
    return next();
  };
}

/** Allows only admins and agents. */
export function requireStaff(req, res, next) {
  if (!req.user || !isStaffRole(req.user.role)) {
    logger.warn('Staff-only route refused', {
      requestId: req.id,
      userId: req.user?.id,
      role: req.user?.role,
      path: req.originalUrl,
    });
    return sendError(req, res, HTTP_STATUS.FORBIDDEN, CONVERSATION_MESSAGES.STAFF_ONLY);
  }
  return next();
}

/**
 * One's own workspace as an employee (attendance, leave, payslips, analytics, OKRs, vault, work
 * calendar, presence, dashboard): everyone but a chartered accountant (USE_EMPLOYEE_WORKSPACE).
 */
export const requireEmployeeWorkspace = requireCapability(
  CAPABILITIES.USE_EMPLOYEE_WORKSPACE,
  COMMON_MESSAGES.WORKSPACE_NOT_ALLOWED,
);
