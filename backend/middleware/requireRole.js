/**
 * Role-based access for routes that run after `protect` (which sets req.user).
 *
 *   router.get('/conversations', protect, requireStaff, listConversations);
 *
 * Roles come from the database on every request (protect reloads the user), so a role change
 * applies immediately. Failure is 403: the caller is signed in but not allowed.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ADMIN_MESSAGES, CONVERSATION_MESSAGES } from '../constants/messages.js';
import { ROLES } from '../models/User.js';
import { isStaffRole } from '../services/conversationAccess.js';
import { sendError } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';

/** Allows only admins. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== ROLES.ADMIN) {
    logger.warn('Admin-only route refused', { requestId: req.id, userId: req.user?.id, role: req.user?.role, path: req.originalUrl });
    return sendError(req, res, HTTP_STATUS.FORBIDDEN, ADMIN_MESSAGES.ADMINS_ONLY);
  }
  return next();
}

/** Allows only admins and agents. */
export function requireStaff(req, res, next) {
  if (!req.user || !isStaffRole(req.user.role)) {
    logger.warn('Staff-only route refused', { requestId: req.id, userId: req.user?.id, role: req.user?.role, path: req.originalUrl });
    return sendError(req, res, HTTP_STATUS.FORBIDDEN, CONVERSATION_MESSAGES.STAFF_ONLY);
  }
  return next();
}
