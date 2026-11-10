/**
 * Scopes every task board request to one department (routes/departmentBoardRoutes.js):
 *
 *   400  :departmentId is not an id
 *   404  no such active department
 *   403  the user is not on this department's board (services/tasks/boardAccess.js); audited
 *
 * Otherwise req.boardScope = { department, board, role, isHead, isAdmin, memberUserIds } for the
 * handlers, which never look a department up again, so a handler cannot act on another department.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { TASK_MESSAGES } from '../constants/messages.js';
import { loadBoardScope } from '../services/tasks/boardAccess.js';
import { ServiceError } from '../services/serviceError.js';
import { sendCodedError, sendError } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';

export const TASK_AUDIT_CATEGORY = 'tasks';

export async function departmentBoardScope(req, res, next) {
  const { departmentId } = req.params;
  if (!isValidObjectIdString(departmentId)) {
    return sendError(req, res, HTTP_STATUS.BAD_REQUEST, TASK_MESSAGES.INPUT_INVALID, [
      { field: 'departmentId', message: 'must be an id' },
    ]);
  }
  try {
    req.boardScope = await loadBoardScope(req.user, departmentId);
    return next();
  } catch (scopeError) {
    if (!(scopeError instanceof ServiceError)) return next(scopeError);
    if (scopeError.httpStatus === HTTP_STATUS.FORBIDDEN) {
      recordAuditEvent(req, {
        category: TASK_AUDIT_CATEGORY,
        action: 'access_task_board',
        outcome: AUDIT_OUTCOMES.DENIED,
        departmentId,
        method: req.method,
      });
    }
    return sendCodedError(req, res, scopeError.httpStatus, { code: scopeError.code, message: scopeError.message });
  }
}
