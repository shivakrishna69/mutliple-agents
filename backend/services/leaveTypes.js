/**
 * Leave types (models/LeaveType.js): HR's list, changes, and the conversion of a type's policy to
 * the centidays the accrual rules work in. Field values are validated by the model.
 */

import mongoose from 'mongoose';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { COMMON_MESSAGES, LEAVE_MESSAGES } from '../constants/messages.js';
import LeaveType from '../models/LeaveType.js';
import { daysToCentidays } from '../utils/leaveDays.js';
import { ServiceError } from './serviceError.js';

const DUPLICATE_KEY_ERROR_CODE = 11000;
/** Nested policy groups, merged field by field on update. */
const POLICY_GROUPS = Object.freeze(['accrual', 'carryForward', 'encashment', 'usage']);

export const leaveTypeNotFound = () =>
  new ServiceError(HTTP_STATUS.NOT_FOUND, 'LEAVE_TYPE_NOT_FOUND', LEAVE_MESSAGES.LEAVE_TYPE_NOT_FOUND);

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

async function saveLeaveType(leaveType) {
  try {
    await leaveType.save();
  } catch (saveError) {
    if (saveError instanceof mongoose.Error.VersionError) {
      throw new ServiceError(HTTP_STATUS.CONFLICT, 'STALE_VERSION', COMMON_MESSAGES.STALE_VERSION);
    }
    if (saveError?.code === DUPLICATE_KEY_ERROR_CODE) {
      throw new ServiceError(HTTP_STATUS.CONFLICT, 'LEAVE_TYPE_CODE_TAKEN', LEAVE_MESSAGES.LEAVE_TYPE_CODE_TAKEN);
    }
    throw saveError;
  }
}

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
 * from now on; entries already in the ledger keep the values they were posted with.
 */
export async function updateLeaveType({ leaveTypeId, changes, version, actorUserId }) {
  const leaveType = await LeaveType.findById(leaveTypeId);
  if (!leaveType) throw leaveTypeNotFound();
  if (leaveType.__v !== version)
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'STALE_VERSION', COMMON_MESSAGES.STALE_VERSION);
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
