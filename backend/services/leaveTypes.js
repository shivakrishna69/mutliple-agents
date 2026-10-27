/**
 * Leave types (models/LeaveType.js): HR's list, changes, and the conversion of a type's policy to
 * the centidays the accrual rules work in. Field values are validated by the model.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { LEAVE_MESSAGES } from '../constants/messages.js';
import LeaveLedgerEntry from '../models/LeaveLedgerEntry.js';
import LeaveType from '../models/LeaveType.js';
import { daysToCentidays } from '../utils/leaveDays.js';
import { assertCurrentVersion, saveVersioned, ServiceError } from './serviceError.js';

/** Nested policy groups, merged field by field on update. */
const POLICY_GROUPS = Object.freeze(['accrual', 'carryForward', 'encashment', 'usage']);

export const leaveTypeNotFound = () =>
  new ServiceError(HTTP_STATUS.NOT_FOUND, 'LEAVE_TYPE_NOT_FOUND', LEAVE_MESSAGES.LEAVE_TYPE_NOT_FOUND);
const codeTaken = () =>
  new ServiceError(HTTP_STATUS.CONFLICT, 'LEAVE_TYPE_CODE_TAKEN', LEAVE_MESSAGES.LEAVE_TYPE_CODE_TAKEN);

export function toLeaveTypeSummary(leaveType) {
  const plain = typeof leaveType.toObject === 'function' ? leaveType.toObject() : leaveType;
  return {
    id: plain._id.toString(),
    code: plain.code,
    name: plain.name,
    description: plain.description,
    isPaid: plain.isPaid,
    tracksBalance: plain.tracksBalance,
    accrual: { ...plain.accrual },
    accrueDuringNotice: plain.accrueDuringNotice,
    carryForward: { ...plain.carryForward },
    encashment: { ...plain.encashment },
    usage: { ...plain.usage, eligibleEmploymentStatuses: [...plain.usage.eligibleEmploymentStatuses] },
    isActive: plain.isActive,
    version: plain.__v,
  };
}

/** The accrual policy in centidays, as services/leaveAccrualRules.js expects. */
export function accrualPolicyOf(leaveType) {
  return {
    accrualMethod: leaveType.accrual.method,
    annualQuotaCentidays: daysToCentidays(leaveType.accrual.annualQuotaDays),
    accrualTiming: leaveType.accrual.timing,
    proRataRoundingStepCentidays: daysToCentidays(leaveType.accrual.proRataRoundingStepDays),
    accrueDuringNotice: leaveType.accrueDuringNotice,
  };
}

/** The lowest a debit may take the available days: zero, or minus the type's negative limit. */
export const lowestAvailableCentidays = (leaveType) =>
  leaveType.usage.allowNegativeBalance ? -daysToCentidays(leaveType.usage.maxNegativeDays) : 0;

const saveLeaveType = (leaveType) => saveVersioned(leaveType, { onDuplicateKey: codeTaken });

/** Active types, ordered by code; HR may include retired ones. */
export async function listLeaveTypes({ includeInactive = false } = {}) {
  const leaveTypes = await LeaveType.find(includeInactive ? {} : { isActive: true }).sort({ code: 1 });
  return leaveTypes.map(toLeaveTypeSummary);
}

export async function createLeaveType({ fields, actorUserId }) {
  const leaveType = new LeaveType({ ...fields, createdByUserId: actorUserId, updatedByUserId: actorUserId });
  await saveLeaveType(leaveType);
  return toLeaveTypeSummary(leaveType);
}

/**
 * Applies HR's changes; nested policy groups are merged field by field. Changes affect movements
 * from now on; entries already in the ledger keep the values they were posted with. Whether the
 * type keeps a balance is fixed once leave has been recorded for it, since its ledger would no
 * longer mean anything.
 */
export async function updateLeaveType({ leaveTypeId, changes, version, actorUserId }) {
  const leaveType = await LeaveType.findById(leaveTypeId);
  if (!leaveType) throw leaveTypeNotFound();
  assertCurrentVersion(leaveType, version);
  const changesTracking = changes.tracksBalance !== undefined && changes.tracksBalance !== leaveType.tracksBalance;
  if (changesTracking && (await LeaveLedgerEntry.exists({ leaveTypeId: leaveType._id }))) {
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'TRACKS_BALANCE_LOCKED', LEAVE_MESSAGES.TRACKS_BALANCE_LOCKED);
  }
  for (const [fieldName, value] of Object.entries(changes)) {
    if (POLICY_GROUPS.includes(fieldName)) {
      for (const [policyField, policyValue] of Object.entries(value))
        leaveType.set(`${fieldName}.${policyField}`, policyValue);
    } else {
      leaveType.set(fieldName, value);
    }
  }
  leaveType.updatedByUserId = actorUserId;
  await saveLeaveType(leaveType);
  return toLeaveTypeSummary(leaveType);
}
