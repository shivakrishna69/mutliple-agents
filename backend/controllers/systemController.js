/**
 * GET /api/system/health   the state of the AI service, email, database and cache
 *                          (services/systemHealth.js). Administrators only; a refusal is audited.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { SYSTEM_HEALTH_MESSAGES } from '../constants/messages.js';
import { CAPABILITIES, hasCapability } from '../constants/accessRoles.js';
import { checkSystemHealth } from '../services/systemHealth.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';

export async function getSystemHealth(req, res, next) {
  try {
    if (!hasCapability(req.user.role, CAPABILITIES.VIEW_SYSTEM_HEALTH)) {
      recordAuditEvent(req, {
        category: 'system',
        action: 'view_system_health',
        outcome: AUDIT_OUTCOMES.DENIED,
        reason: 'role_not_allowed',
      });
      return sendError(req, res, HTTP_STATUS.FORBIDDEN, SYSTEM_HEALTH_MESSAGES.ADMIN_ONLY);
    }
    const health = await checkSystemHealth({ aiServiceUrl: req.app.locals.config.aiServiceUrl });
    return sendSuccess(res, HTTP_STATUS.OK, SYSTEM_HEALTH_MESSAGES.RETRIEVED, health);
  } catch (error) {
    return next(error);
  }
}
