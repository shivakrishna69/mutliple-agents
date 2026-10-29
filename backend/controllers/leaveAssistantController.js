/**
 * POST /api/leave/assistant { message, history? }: the leave assistant (ai-service
 * app/nodes/leave_assistant/), for employees on their own leave.
 *
 * The backend decides whose leave the assistant may read: the signed-in employee's, passed to the
 * ai-service with their name, today and time zone; the assistant's tools call back into
 * /api/internal/leave for that employee only. The assistant never writes: it can propose a draft,
 * which is checked here against the leave rules (an offered type, real dates, valid half days)
 * and returned for the employee to review and send through the normal form. A draft that fails
 * the check is dropped and the reply is still shown.
 *
 * The conversation lives in the browser and is sent with each question (bounded in size); nothing
 * is stored. Every question is audited with the tools the assistant used, never the text.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { LEAVE_LIMITS } from '../constants/validation.js';
import { LEAVE_MESSAGES } from '../constants/messages.js';
import LeaveType from '../models/LeaveType.js';
import { AiServiceError, requestLeaveAssistant } from '../services/aiServiceClient.js';
import { loadEmployeeLeaveContext } from '../services/leaveSettings.js';
import { ServiceError } from '../services/serviceError.js';
import { logger } from '../utils/logger.js';
import { validateAssistantMessage, validateLeaveRequestInput } from '../validators/leaveRequestValidators.js';
import { leaveHandler, requireOwnEmployeeId } from './leaveController.js';

const ASKS_THE_ASSISTANT = Object.freeze({ requiresWorkforceAdmin: false, isWrite: true });

/** The draft as the apply form takes it, or null when it does not follow the leave rules. */
async function checkedDraft(draft) {
  if (!draft) return null;
  const reason = draft.reason?.trim() || null;
  const validation = validateLeaveRequestInput(
    {
      leaveTypeId: draft.leaveTypeId,
      startDate: draft.startDate,
      startDayPortion: draft.startDayPortion ?? undefined,
      endDate: draft.endDate,
      endDayPortion: draft.endDayPortion ?? undefined,
    },
    { isPreview: true },
  );
  const isOfferedType = validation.isValid && (await LeaveType.exists({ _id: draft.leaveTypeId, isActive: true }));
  if (!isOfferedType || (reason && reason.length > LEAVE_LIMITS.NOTE_MAX_LENGTH)) {
    logger.warn('Leave assistant draft dropped: it does not follow the leave rules', {
      fields: validation.isValid ? ['leaveTypeId'] : validation.validationErrors.map((error) => error.field),
    });
    return null;
  }
  return { ...validation.sanitizedInput, reason };
}

/** POST /api/leave/assistant */
export const postAssistantMessage = leaveHandler('ask_leave_assistant', ASKS_THE_ASSISTANT, async (req) => {
  const validation = validateAssistantMessage(req.body);
  if (!validation.isValid) return validation;
  const employeeId = await requireOwnEmployeeId(req);
  const { today, timeZone } = await loadEmployeeLeaveContext(employeeId);
  let answer;
  try {
    answer = await requestLeaveAssistant(
      {
        employee_id: employeeId,
        employee_name: req.user.name,
        today,
        time_zone: timeZone,
        history: validation.sanitizedInput.history,
        message: validation.sanitizedInput.message,
      },
      { config: req.app.locals.config, requestId: req.id },
    );
  } catch (assistantError) {
    if (!(assistantError instanceof AiServiceError)) throw assistantError;
    logger.warn('Leave assistant unavailable', {
      failureKind: assistantError.failureKind,
      httpStatus: assistantError.httpStatus,
      durationMs: assistantError.durationMs,
    });
    throw new ServiceError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      'ASSISTANT_UNAVAILABLE',
      LEAVE_MESSAGES.ASSISTANT_UNAVAILABLE,
    );
  }
  const draft = await checkedDraft(answer.draft);
  return {
    message: LEAVE_MESSAGES.ASSISTANT_REPLIED,
    data: { reply: answer.reply, draft },
    auditDetails: { toolsUsed: answer.toolsUsed, draftProposed: Boolean(draft), durationMs: answer.durationMs },
  };
});
