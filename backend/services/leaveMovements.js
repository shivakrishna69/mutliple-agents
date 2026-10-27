/**
 * Movements HR posts by hand: adjustments and encashments. Requests are checked for shape by
 * validators/leaveValidators.js; this service applies the policy of the leave type and posts
 * through services/leaveLedger.js, which keeps the balance from being overdrawn even when two
 * movements arrive at once.
 *
 *   Adjustment   MANUAL (add or remove days) or ENTITLEMENT_GRANT (add), with a note, in the
 *                current leave year, or the previous one until its year end has been posted (after
 *                that its closing figures are final). Removing days may not take the available
 *                days below zero, or below the type's negative limit when it allows one.
 *   Encashment   days paid out by payroll from the current leave year, for encashable types only,
 *                never leaving fewer available days than the type retains. Each payroll reference
 *                is used once per employee and type.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { LEAVE_MESSAGES } from '../constants/messages.js';
import LeaveBalance from '../models/LeaveBalance.js';
import LeaveLedgerEntry, { CLOSING_YEAR_END_KINDS, LEDGER_ENTRY_TYPES } from '../models/LeaveLedgerEntry.js';
import LeaveType from '../models/LeaveType.js';
import { daysToCentidays } from '../utils/leaveDays.js';
import { isYearEndPayrollReference } from './leaveAccrualJob.js';
import { toBalanceFigures, toLedgerEntrySummary } from './leaveBalances.js';
import { DuplicateLedgerEntryError, InsufficientLeaveBalanceError, postCredit, postDebit } from './leaveLedger.js';
import { loadEmployeeLeaveContext } from './leaveSettings.js';
import { leaveTypeNotFound } from './leaveTypes.js';
import { leaveYearRange } from './leaveYear.js';
import { ServiceError } from './serviceError.js';

const unprocessable = (code) => new ServiceError(HTTP_STATUS.UNPROCESSABLE_CONTENT, code, LEAVE_MESSAGES[code]);

async function loadBalanceKeepingType(leaveTypeId) {
  const leaveType = await LeaveType.findById(leaveTypeId).lean();
  if (!leaveType) throw leaveTypeNotFound();
  if (!leaveType.tracksBalance) throw unprocessable('BALANCE_NOT_TRACKED');
  return leaveType;
}

/** The lowest the available days may go: zero, or minus the type's negative limit. */
const lowestAvailableCentidays = (leaveType) =>
  leaveType.usage.allowNegativeBalance ? -daysToCentidays(leaveType.usage.maxNegativeDays) : 0;

async function assertLeaveYearOpen({ employeeId, leaveTypeId, leaveYear, currentLeaveYear }) {
  if (leaveYear === currentLeaveYear) return;
  const isPreviousYear = leaveYear === currentLeaveYear - 1;
  const isClosed =
    !isPreviousYear ||
    (await LeaveLedgerEntry.exists({
      employeeId,
      leaveTypeId,
      leaveYear,
      yearEndKind: { $in: CLOSING_YEAR_END_KINDS },
    }));
  if (isClosed) throw unprocessable('LEAVE_YEAR_NOT_OPEN');
}

/** The posted entry with the type's balance after it. */
async function movementResult(entry) {
  const balance = await LeaveBalance.findOne({
    employeeId: entry.employeeId,
    leaveTypeId: entry.leaveTypeId,
    leaveYear: entry.leaveYear,
  }).lean();
  return { entry: toLedgerEntrySummary(entry), balance: toBalanceFigures(balance) };
}

/**
 * @param {{ employeeId: string, leaveTypeId: string, leaveYear: number|null, reasonCode: string,
 *   days: number, note: string, actorUserId: string, now?: Date }} input
 * @throws {ServiceError} 404 employee / type; 422 BALANCE_NOT_TRACKED, LEAVE_YEAR_NOT_OPEN,
 *   INSUFFICIENT_BALANCE
 */
export async function postHrAdjustment({
  employeeId,
  leaveTypeId,
  leaveYear,
  reasonCode,
  days,
  note,
  actorUserId,
  now,
}) {
  const { settings, today, currentLeaveYear } = await loadEmployeeLeaveContext(employeeId, { now });
  const leaveType = await loadBalanceKeepingType(leaveTypeId);
  const year = leaveYear ?? currentLeaveYear;
  await assertLeaveYearOpen({ employeeId, leaveTypeId: leaveType._id, leaveYear: year, currentLeaveYear });
  const { lastDate } = leaveYearRange(year, settings.leaveYearStartMonth);
  const fields = {
    employeeId,
    leaveTypeId: leaveType._id,
    leaveYear: year,
    entryType: LEDGER_ENTRY_TYPES.ADJUSTMENT,
    reasonCode,
    balanceDeltaCentidays: daysToCentidays(days),
    // Today, or the last day of a previous leave year.
    effectiveDate: today < lastDate ? today : lastDate,
    note,
    createdByUserId: actorUserId,
  };
  if (fields.balanceDeltaCentidays > 0) return movementResult((await postCredit(fields)).entry);
  try {
    const { entry } = await postDebit(fields, { minimumAvailableCentidays: lowestAvailableCentidays(leaveType) });
    return movementResult(entry);
  } catch (debitError) {
    if (debitError instanceof InsufficientLeaveBalanceError) throw unprocessable('INSUFFICIENT_BALANCE');
    throw debitError;
  }
}

/**
 * @param {{ employeeId: string, leaveTypeId: string, days: number, payrollReference: string,
 *   payrollMonth: string, note: string|null, actorUserId: string, now?: Date }} input
 * @throws {ServiceError} 404 employee / type; 422 BALANCE_NOT_TRACKED, NOT_ENCASHABLE,
 *   PAYROLL_REFERENCE_RESERVED, ENCASHMENT_EXCEEDS_LIMIT; 409 DUPLICATE_ENCASHMENT
 */
export async function postEncashment({
  employeeId,
  leaveTypeId,
  days,
  payrollReference,
  payrollMonth,
  note,
  actorUserId,
  now,
}) {
  const { today, currentLeaveYear } = await loadEmployeeLeaveContext(employeeId, { now });
  const leaveType = await loadBalanceKeepingType(leaveTypeId);
  if (!leaveType.encashment.isEncashable) throw unprocessable('NOT_ENCASHABLE');
  if (isYearEndPayrollReference(payrollReference)) throw unprocessable('PAYROLL_REFERENCE_RESERVED');
  const fields = {
    employeeId,
    leaveTypeId: leaveType._id,
    leaveYear: currentLeaveYear,
    entryType: LEDGER_ENTRY_TYPES.ENCASHMENT,
    balanceDeltaCentidays: -daysToCentidays(days),
    effectiveDate: today,
    payrollReference,
    payrollMonth,
    note,
    createdByUserId: actorUserId,
  };
  try {
    const { entry } = await postDebit(fields, {
      minimumAvailableCentidays: daysToCentidays(leaveType.encashment.minBalanceRetainedDays),
    });
    return movementResult(entry);
  } catch (debitError) {
    if (debitError instanceof InsufficientLeaveBalanceError) throw unprocessable('ENCASHMENT_EXCEEDS_LIMIT');
    if (debitError instanceof DuplicateLedgerEntryError) {
      throw new ServiceError(HTTP_STATUS.CONFLICT, 'DUPLICATE_ENCASHMENT', LEAVE_MESSAGES.DUPLICATE_ENCASHMENT);
    }
    throw debitError;
  }
}
