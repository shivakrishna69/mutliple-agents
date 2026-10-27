/**
 * Leave endpoints (routes/leaveRoutes.js): settings, leave types, balances, the ledger, HR's
 * adjustments and encashments, and the leave job.
 *
 * Who may do what:
 *   HR and admins     change settings and types; read anyone's balances and ledger; adjust and
 *                     encash (never their own balance: another HR user or an admin does that);
 *                     run the leave job and reconciliation
 *   employees         read the settings, the active types, and their own balances and ledger
 *   anyone else       nothing (no employee profile means no leave)
 * Every change is audited with ids and outcomes.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { LEAVE_MESSAGES } from '../constants/messages.js';
import { runLeaveAccruals } from '../services/leaveAccrualJob.js';
import { getEmployeeBalances, getEmployeeLedger } from '../services/leaveBalances.js';
import { reconcileLeaveBalances } from '../services/leaveLedger.js';
import { postEncashment, postHrAdjustment } from '../services/leaveMovements.js';
import {
  employeeToday,
  getLeaveSettings,
  toLeaveSettingsSummary,
  updateLeaveSettings,
} from '../services/leaveSettings.js';
import { createLeaveType, listLeaveTypes, updateLeaveType } from '../services/leaveTypes.js';
import { ServiceError } from '../services/serviceError.js';
import { findOwnEmployeeProfileId, isWorkforceAdmin } from '../services/workforceAccess.js';
import {
  validateAccrualJobRun,
  validateAdjustment,
  validateEncashment,
  validateLeaveSettingsChanges,
  validateLeaveTypeChanges,
  validateLeaveTypeCreation,
  validateLeaveTypeListQuery,
  validateLeaveYearQuery,
} from '../validators/leaveValidators.js';
import { createWorkforceHandlerFactory, idParamErrors } from './workforceHandler.js';

const leaveHandler = createWorkforceHandlerFactory({
  auditCategory: 'leave',
  restrictedMessage: LEAVE_MESSAGES.RESTRICTED,
  inputInvalidMessage: LEAVE_MESSAGES.INPUT_INVALID,
});

const ANY_VIEWER = Object.freeze({ requiresWorkforceAdmin: false, isWrite: false });
const ADMIN_READ = Object.freeze({ requiresWorkforceAdmin: true, isWrite: false });
const ADMIN_WRITE = Object.freeze({ requiresWorkforceAdmin: true, isWrite: true });

const employeesOnly = () => new ServiceError(HTTP_STATUS.FORBIDDEN, 'EMPLOYEES_ONLY', LEAVE_MESSAGES.EMPLOYEES_ONLY);

/** HR and admins, or a user with an employee profile; anyone else is refused. */
async function assertLeaveViewer(req) {
  if (isWorkforceAdmin(req.user.role)) return;
  if (!(await findOwnEmployeeProfileId(req.user.id))) throw employeesOnly();
}

/** The caller's own employee profile id. */
async function requireOwnEmployeeId(req) {
  const ownEmployeeId = await findOwnEmployeeProfileId(req.user.id);
  if (!ownEmployeeId) throw employeesOnly();
  return ownEmployeeId;
}

/** HR may not move days in or out of their own balance. */
async function assertNotOwnBalance(req, employeeId) {
  if ((await findOwnEmployeeProfileId(req.user.id)) === employeeId) {
    throw new ServiceError(HTTP_STATUS.FORBIDDEN, 'OWN_BALANCE_RESTRICTED', LEAVE_MESSAGES.OWN_BALANCE_RESTRICTED);
  }
}

// =================================================================================================
// Settings and types
// =================================================================================================

/** GET /api/leave/settings */
export const getSettings = leaveHandler('view_leave_settings', ANY_VIEWER, async (req) => {
  await assertLeaveViewer(req);
  return {
    message: LEAVE_MESSAGES.SETTINGS_RETRIEVED,
    data: { settings: toLeaveSettingsSummary(await getLeaveSettings()) },
  };
});

/** PATCH /api/leave/settings */
export const patchSettings = leaveHandler('update_leave_settings', ADMIN_WRITE, async (req) => {
  const validation = validateLeaveSettingsChanges(req.body);
  if (!validation.isValid) return validation;
  const settings = await updateLeaveSettings({ ...validation.sanitizedInput, actorUserId: req.user.id });
  return {
    message: LEAVE_MESSAGES.SETTINGS_UPDATED,
    data: { settings },
    auditDetails: { changedFields: Object.keys(validation.sanitizedInput.changes) },
  };
});

/** GET /api/leave/types[?includeInactive=true] (retired types for HR only) */
export const getTypes = leaveHandler('list_leave_types', ANY_VIEWER, async (req) => {
  await assertLeaveViewer(req);
  const validation = validateLeaveTypeListQuery(req.query);
  if (!validation.isValid) return validation;
  const includeInactive = validation.sanitizedInput.includeInactive && isWorkforceAdmin(req.user.role);
  return { message: LEAVE_MESSAGES.TYPES_RETRIEVED, data: { leaveTypes: await listLeaveTypes({ includeInactive }) } };
});

/** POST /api/leave/types */
export const postType = leaveHandler('create_leave_type', ADMIN_WRITE, async (req) => {
  const validation = validateLeaveTypeCreation(req.body);
  if (!validation.isValid) return validation;
  const leaveType = await createLeaveType({ fields: validation.sanitizedInput, actorUserId: req.user.id });
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: LEAVE_MESSAGES.TYPE_CREATED,
    data: { leaveType },
    auditDetails: { leaveTypeId: leaveType.id, code: leaveType.code },
  };
});

/** PATCH /api/leave/types/:leaveTypeId */
export const patchType = leaveHandler('update_leave_type', ADMIN_WRITE, async (req) => {
  const invalidParams = idParamErrors(req.params, 'leaveTypeId');
  if (invalidParams) return { validationErrors: invalidParams };
  const validation = validateLeaveTypeChanges(req.body);
  if (!validation.isValid) return validation;
  const leaveType = await updateLeaveType({
    leaveTypeId: req.params.leaveTypeId,
    ...validation.sanitizedInput,
    actorUserId: req.user.id,
  });
  return {
    message: LEAVE_MESSAGES.TYPE_UPDATED,
    data: { leaveType },
    auditDetails: { leaveTypeId: leaveType.id, changedFields: Object.keys(validation.sanitizedInput.changes) },
  };
});

// =================================================================================================
// Balances and ledger
// =================================================================================================

/** GET /api/leave/balances[?leaveYear=] : the caller's own */
export const getOwnBalances = leaveHandler('view_own_leave_balances', ANY_VIEWER, async (req) => {
  const validation = validateLeaveYearQuery(req.query);
  if (!validation.isValid) return validation;
  const employeeId = await requireOwnEmployeeId(req);
  const balances = await getEmployeeBalances({ employeeId, leaveYear: validation.sanitizedInput.leaveYear });
  return { message: LEAVE_MESSAGES.BALANCES_RETRIEVED, data: balances };
});

/** GET /api/leave/ledger[?leaveYear=&leaveTypeId=] : the caller's own */
export const getOwnLedger = leaveHandler('view_own_leave_ledger', ANY_VIEWER, async (req) => {
  const validation = validateLeaveYearQuery(req.query);
  if (!validation.isValid) return validation;
  const employeeId = await requireOwnEmployeeId(req);
  return {
    message: LEAVE_MESSAGES.LEDGER_RETRIEVED,
    data: await getEmployeeLedger({ employeeId, ...validation.sanitizedInput }),
  };
});

/** GET /api/leave/employees/:employeeId/balances[?leaveYear=] */
export const getBalancesOfEmployee = leaveHandler('view_leave_balances', ADMIN_READ, async (req) => {
  const invalidParams = idParamErrors(req.params, 'employeeId');
  if (invalidParams) return { validationErrors: invalidParams };
  const validation = validateLeaveYearQuery(req.query);
  if (!validation.isValid) return validation;
  const balances = await getEmployeeBalances({
    employeeId: req.params.employeeId,
    leaveYear: validation.sanitizedInput.leaveYear,
  });
  return { message: LEAVE_MESSAGES.BALANCES_RETRIEVED, data: balances };
});

/** GET /api/leave/employees/:employeeId/ledger[?leaveYear=&leaveTypeId=] */
export const getLedgerOfEmployee = leaveHandler('view_leave_ledger', ADMIN_READ, async (req) => {
  const invalidParams = idParamErrors(req.params, 'employeeId');
  if (invalidParams) return { validationErrors: invalidParams };
  const validation = validateLeaveYearQuery(req.query);
  if (!validation.isValid) return validation;
  return {
    message: LEAVE_MESSAGES.LEDGER_RETRIEVED,
    data: await getEmployeeLedger({ employeeId: req.params.employeeId, ...validation.sanitizedInput }),
  };
});

// =================================================================================================
// Movements
// =================================================================================================

/** POST /api/leave/adjustments */
export const postAdjustment = leaveHandler('post_leave_adjustment', ADMIN_WRITE, async (req) => {
  const validation = validateAdjustment(req.body);
  if (!validation.isValid) return validation;
  const input = validation.sanitizedInput;
  await assertNotOwnBalance(req, input.employeeId);
  const movement = await postHrAdjustment({ ...input, actorUserId: req.user.id });
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: LEAVE_MESSAGES.ADJUSTMENT_POSTED,
    data: movement,
    auditDetails: {
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      ledgerEntryId: movement.entry.id,
      reasonCode: input.reasonCode,
      days: input.days,
    },
  };
});

/** POST /api/leave/encashments */
export const postEncashmentEntry = leaveHandler('post_leave_encashment', ADMIN_WRITE, async (req) => {
  const validation = validateEncashment(req.body);
  if (!validation.isValid) return validation;
  const input = validation.sanitizedInput;
  await assertNotOwnBalance(req, input.employeeId);
  const movement = await postEncashment({ ...input, actorUserId: req.user.id });
  return {
    httpStatus: HTTP_STATUS.CREATED,
    message: LEAVE_MESSAGES.ENCASHMENT_POSTED,
    data: movement,
    auditDetails: {
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      ledgerEntryId: movement.entry.id,
      payrollReference: input.payrollReference,
      days: input.days,
    },
  };
});

// =================================================================================================
// Jobs
// =================================================================================================

/** POST /api/leave/jobs/accrual { asOfDate? } : catch up accruals and year ends now */
export const postAccrualJobRun = leaveHandler('run_leave_job', ADMIN_WRITE, async (req) => {
  const validation = validateAccrualJobRun(req.body);
  if (!validation.isValid) return validation;
  const { asOfDate } = validation.sanitizedInput;
  if (asOfDate && asOfDate > employeeToday({ officeTimeZone: null, settings: await getLeaveSettings() })) {
    throw new ServiceError(HTTP_STATUS.UNPROCESSABLE_CONTENT, 'FUTURE_RUN_DATE', LEAVE_MESSAGES.FUTURE_RUN_DATE);
  }
  const summary = await runLeaveAccruals({ asOfDate });
  return { message: LEAVE_MESSAGES.JOB_COMPLETED, data: { summary }, auditDetails: { asOfDate, ...summary } };
});

/** POST /api/leave/jobs/reconcile : bring every balance back in line with the ledger */
export const postReconcileRun = leaveHandler('reconcile_leave_balances', ADMIN_WRITE, async () => {
  const summary = await reconcileLeaveBalances();
  return { message: LEAVE_MESSAGES.RECONCILED, data: { summary }, auditDetails: summary };
});
