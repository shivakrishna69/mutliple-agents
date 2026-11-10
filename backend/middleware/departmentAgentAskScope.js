/**
 * Scopes a question to one department's agent (POST /api/departments/:departmentId/agent/chat):
 *
 *   400  :departmentId is not an id
 *   404  no such active department
 *   403  this person may not ask it (their role, no employee record, or not in its audience;
 *        services/agentChat/agentAudience.js); audited
 *   409  the agent is paused, or has no document ready to answer from
 *
 * Otherwise req.agentScope = { department, agent, membership } for the handler, which never looks a
 * department up again.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { AGENT_CHAT_MESSAGES } from '../constants/messages.js';
import { loadAskScope } from '../services/agentChat/agentChatService.js';
import { ServiceError } from '../services/serviceError.js';
import { sendCodedError, sendError } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';

export const AGENT_CHAT_AUDIT_CATEGORY = 'agent_chat';

export async function departmentAgentAskScope(req, res, next) {
  const { departmentId } = req.params;
  if (!isValidObjectIdString(departmentId)) {
    return sendError(req, res, HTTP_STATUS.BAD_REQUEST, AGENT_CHAT_MESSAGES.INPUT_INVALID, [
      { field: 'departmentId', message: 'must be an id' },
    ]);
  }
  try {
    req.agentScope = await loadAskScope(req.user, departmentId);
    return next();
  } catch (scopeError) {
    if (!(scopeError instanceof ServiceError)) return next(scopeError);
    if (scopeError.httpStatus === HTTP_STATUS.FORBIDDEN) {
      recordAuditEvent(req, {
        category: AGENT_CHAT_AUDIT_CATEGORY,
        action: 'ask_department_agent',
        outcome: AUDIT_OUTCOMES.DENIED,
        departmentId,
        reason: scopeError.code,
      });
    }
    return sendCodedError(req, res, scopeError.httpStatus, { code: scopeError.code, message: scopeError.message });
  }
}
