/**
 * Builds the Express handlers of HR features, so every feature applies the same rules:
 *   - an optional HR/admin gate (services/workforceAccess.js);
 *   - validation errors returned as 400 with field details, whether they come from a request
 *     validator or from the Mongoose model, which stays the single authority for field values;
 *   - ServiceError mapped to its status and stable code;
 *   - every change audited with its outcome (allowed, denied, rejected).
 *
 * A handler body returns { validationErrors } or { httpStatus?, message, data, auditDetails? }.
 */

import mongoose from 'mongoose';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ServiceError } from '../services/serviceError.js';
import { isWorkforceAdmin } from '../services/workforceAccess.js';
import { sendCodedError, sendError, sendSuccess } from '../utils/apiResponse.js';
import { AUDIT_OUTCOMES, recordAuditEvent } from '../utils/auditLogger.js';
import { isValidObjectIdString } from '../validators/conversationValidators.js';

/** Field details for a Mongoose validation error: one entry per invalid path. */
function modelValidationDetails(validationError) {
  return Object.values(validationError.errors).map((fieldError) => ({
    field: fieldError.path,
    message: fieldError.message,
  }));
}

/** [{ field, message }] when the route parameter is not an id, otherwise null. */
export function idParamErrors(params, paramName) {
  return isValidObjectIdString(params[paramName]) ? null : [{ field: paramName, message: 'must be an id' }];
}

/**
 * @param {{ auditCategory: string, restrictedMessage: string, inputInvalidMessage: string }} feature
 * @returns {(action: string, options: { requiresWorkforceAdmin: boolean, isWrite: boolean },
 *            handlerBody: (req) => Promise<object>) => import('express').RequestHandler}
 */
export function createWorkforceHandlerFactory({ auditCategory, restrictedMessage, inputInvalidMessage }) {
  const audit = (req, action, outcome, details = {}) =>
    recordAuditEvent(req, { category: auditCategory, action, outcome, ...details });

  return function workforceHandler(action, { requiresWorkforceAdmin, isWrite }, handlerBody) {
    return async (req, res, next) => {
      try {
        if (requiresWorkforceAdmin && !isWorkforceAdmin(req.user.role)) {
          if (isWrite) audit(req, action, AUDIT_OUTCOMES.DENIED);
          return sendError(req, res, HTTP_STATUS.FORBIDDEN, restrictedMessage);
        }
        try {
          const handlerResult = await handlerBody(req);
          if (handlerResult.validationErrors) {
            return sendError(req, res, HTTP_STATUS.BAD_REQUEST, inputInvalidMessage, handlerResult.validationErrors);
          }
          if (isWrite) audit(req, action, AUDIT_OUTCOMES.ALLOWED, handlerResult.auditDetails);
          return sendSuccess(
            res,
            handlerResult.httpStatus ?? HTTP_STATUS.OK,
            handlerResult.message,
            handlerResult.data,
          );
        } catch (handlerError) {
          if (handlerError instanceof mongoose.Error.ValidationError) {
            if (isWrite) audit(req, action, AUDIT_OUTCOMES.REJECTED, { reason: 'validation_failed' });
            return sendError(
              req,
              res,
              HTTP_STATUS.BAD_REQUEST,
              inputInvalidMessage,
              modelValidationDetails(handlerError),
            );
          }
          if (!(handlerError instanceof ServiceError)) throw handlerError;
          if (isWrite) {
            const outcome =
              handlerError.httpStatus === HTTP_STATUS.FORBIDDEN ? AUDIT_OUTCOMES.DENIED : AUDIT_OUTCOMES.REJECTED;
            audit(req, action, outcome, { reason: handlerError.code });
          }
          return sendCodedError(req, res, handlerError.httpStatus, {
            code: handlerError.code,
            message: handlerError.message,
          });
        }
      } catch (error) {
        return next(error);
      }
    };
  };
}
