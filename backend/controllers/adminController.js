/**
 * Administration routes (admins only), replacing the command-line role script for deployments.
 *
 *   GET   /api/admin/users?search=&role=     list users (newest first, at most USER_LIST_LIMIT)
 *   PATCH /api/admin/users/:userId/role      { role: 'admin' | 'agent' | 'hr' | 'customer' }
 *
 * Role changes:
 *   - An admin cannot change their own role, so the last admin can never demote themselves and
 *     lock everyone out of administration.
 *   - The change applies to HTTP requests immediately (every request reloads the user). The user's
 *     open sockets cached the old role, so they are closed with SESSION_ENDED (role_changed); the
 *     client signs in again and gets a connection with the new role.
 *   - Every change is logged with who made it, for audit.
 */

import User, { ROLES } from '../models/User.js';
import { ADMIN_MESSAGES } from '../constants/messages.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';
import { SOCKET_ERROR_CODES, disconnectUserSockets } from '../utils/socketManager.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';

const USER_LIST_LIMIT = 200;
const MAX_SEARCH_LENGTH = 100;
const ALLOWED_ROLES = Object.values(ROLES);

function toAdminUserSummary(userRecord) {
  return {
    id: userRecord._id.toString(),
    name: userRecord.name,
    email: userRecord.email,
    role: userRecord.role,
    createdAt: userRecord.createdAt,
  };
}

/** Escapes text so it matches literally inside a RegExp (search input is never a pattern). */
function escapeRegularExpression(searchText) {
  return searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** GET /api/admin/users */
export async function listUsers(req, res, next) {
  try {
    const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const rawRole = typeof req.query.role === 'string' ? req.query.role.trim() : '';
    if (rawSearch.length > MAX_SEARCH_LENGTH) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, ADMIN_MESSAGES.SEARCH_TOO_LONG);
    }
    if (rawRole && !ALLOWED_ROLES.includes(rawRole)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, ADMIN_MESSAGES.INVALID_ROLE);
    }

    const userFilter = {};
    if (rawRole) userFilter.role = rawRole;
    if (rawSearch) {
      const searchPattern = new RegExp(escapeRegularExpression(rawSearch), 'i');
      userFilter.$or = [{ name: searchPattern }, { email: searchPattern }];
    }

    const [userRecords, roleCounts] = await Promise.all([
      User.find(userFilter).select('_id name email role createdAt').sort({ createdAt: -1 }).limit(USER_LIST_LIMIT).lean(),
      User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
    ]);
    const countsByRole = Object.fromEntries(ALLOWED_ROLES.map((role) => [role, 0]));
    for (const roleCount of roleCounts) countsByRole[roleCount._id] = roleCount.count;

    return sendSuccess(res, HTTP_STATUS.OK, ADMIN_MESSAGES.USERS_RETRIEVED, {
      users: userRecords.map(toAdminUserSummary),
      countsByRole,
    });
  } catch (error) {
    return next(error);
  }
}

/** PATCH /api/admin/users/:userId/role */
export async function updateUserRole(req, res, next) {
  try {
    const { userId } = req.params;
    const requestedRole = req.body?.role;
    if (!isValidObjectIdString(userId)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, ADMIN_MESSAGES.INVALID_USER_ID);
    }
    if (typeof requestedRole !== 'string' || !ALLOWED_ROLES.includes(requestedRole)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, ADMIN_MESSAGES.INVALID_ROLE, [{ field: 'role', message: ADMIN_MESSAGES.INVALID_ROLE }]);
    }
    if (userId === req.user.id) {
      return sendError(req, res, HTTP_STATUS.CONFLICT, ADMIN_MESSAGES.CANNOT_CHANGE_OWN_ROLE);
    }

    const userRecord = await User.findById(userId);
    if (!userRecord) {
      return sendError(req, res, HTTP_STATUS.NOT_FOUND, ADMIN_MESSAGES.USER_NOT_FOUND);
    }
    if (userRecord.role === requestedRole) {
      return sendSuccess(res, HTTP_STATUS.OK, ADMIN_MESSAGES.ROLE_UNCHANGED, { user: toAdminUserSummary(userRecord) });
    }

    const previousRole = userRecord.role;
    userRecord.role = requestedRole;
    await userRecord.save();
    disconnectUserSockets(userId, SOCKET_ERROR_CODES.ROLE_CHANGED);

    logger.info('User role changed', { requestId: req.id, adminUserId: req.user.id, targetUserId: userId, previousRole, newRole: requestedRole });
    return sendSuccess(res, HTTP_STATUS.OK, ADMIN_MESSAGES.ROLE_UPDATED, { user: toAdminUserSummary(userRecord) });
  } catch (error) {
    return next(error);
  }
}
