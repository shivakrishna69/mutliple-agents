/**
 * Scopes every knowledge base request to one department (routes/departmentKnowledgeRoutes.js):
 *
 *   400  :departmentId is not an id
 *   404  no such department
 *   403  the user may not manage this department's knowledge base (services/knowledge/knowledgeAccess.js);
 *        audited, for reads as well as changes
 *   409  the department is inactive
 *
 * Otherwise req.knowledgeScope = { department, agent, access } for the handlers, which never look a
 * department up again, so a handler cannot act on another department's knowledge.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { KNOWLEDGE_MESSAGES } from '../constants/messages.js';
import { ServiceError } from '../services/serviceError.js';
import { loadKnowledgeScope } from '../services/knowledge/knowledgeBaseService.js';
import { sendCodedError, sendError } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';

export const KNOWLEDGE_AUDIT_CATEGORY = 'knowledge';

export async function departmentKnowledgeScope(req, res, next) {
  const { departmentId } = req.params;
  if (!isValidObjectIdString(departmentId)) {
    return sendError(req, res, HTTP_STATUS.BAD_REQUEST, KNOWLEDGE_MESSAGES.INPUT_INVALID, [
      { field: 'departmentId', message: 'must be an id' },
    ]);
  }
  try {
    req.knowledgeScope = await loadKnowledgeScope(req.user, departmentId);
    return next();
  } catch (scopeError) {
    if (!(scopeError instanceof ServiceError)) return next(scopeError);
    if (scopeError.httpStatus === HTTP_STATUS.FORBIDDEN) {
      recordAuditEvent(req, {
        category: KNOWLEDGE_AUDIT_CATEGORY,
        action: 'access_knowledge_base',
        outcome: AUDIT_OUTCOMES.DENIED,
        departmentId,
        method: req.method,
      });
    }
    return sendCodedError(req, res, scopeError.httpStatus, { code: scopeError.code, message: scopeError.message });
  }
}
