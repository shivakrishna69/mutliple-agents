/**
 * Reading leave: an employee's balances for a leave year, with where the days came from and went,
 * and their ledger. Permission checks (own data, or HR) are made by the controller.
 *
 * Every figure comes from the ledger the balance is the running total of, in days:
 *   balance     what the employee has (credits minus debits)
 *   held        reserved by pending requests (Phase 3)
 *   available   balance - held: what a new request or debit may use
 *   movements   the balance broken down by kind, each signed as it changed the balance, so they add
 *               up to the balance: accrued, carriedIn, adjusted, used, encashed, lapsed, carriedOut
 */

import mongoose from 'mongoose';
import LeaveBalance from '../models/LeaveBalance.js';
import LeaveLedgerEntry, {
  ADJUSTMENT_REASON_CODES,
  LEDGER_ENTRY_TYPES,
  YEAR_END_KINDS,
} from '../models/LeaveLedgerEntry.js';
import LeaveType from '../models/LeaveType.js';
import { centidaysToDays } from '../utils/leaveDays.js';
import { loadEmployeeLeaveContext } from './leaveSettings.js';
import { leaveYearRange } from './leaveYear.js';

const MOVEMENT_KINDS = Object.freeze(['accrued', 'carriedIn', 'adjusted', 'used', 'encashed', 'lapsed', 'carriedOut']);

/** Which movement kind an entry counts towards; null for entries that do not change the balance. */
function movementKindOf({ entryType, reasonCode, yearEndKind }) {
  switch (entryType) {
    case LEDGER_ENTRY_TYPES.ACCRUAL:
      return 'accrued';
    case LEDGER_ENTRY_TYPES.CONFIRM_DEBIT:
      return 'used';
    case LEDGER_ENTRY_TYPES.ENCASHMENT:
      return 'encashed';
    case LEDGER_ENTRY_TYPES.ADJUSTMENT:
      if (reasonCode === ADJUSTMENT_REASON_CODES.CARRY_FORWARD) {
        return yearEndKind === YEAR_END_KINDS.CARRY_FORWARD_IN ? 'carriedIn' : 'carriedOut';
      }
      if (reasonCode === ADJUSTMENT_REASON_CODES.LAPSE) return 'lapsed';
      // Days given back when approved leave is cancelled reduce what was used.
      if (reasonCode === ADJUSTMENT_REASON_CODES.CANCELLATION_CREDIT) return 'used';
      return 'adjusted';
    default:
      return null;
  }
}

const emptyMovements = () => Object.fromEntries(MOVEMENT_KINDS.map((kind) => [kind, 0]));

export function toLedgerEntrySummary(entry) {
  return {
    id: entry._id.toString(),
    leaveTypeId: entry.leaveTypeId.toString(),
    leaveYear: entry.leaveYear,
    entryType: entry.entryType,
    reasonCode: entry.reasonCode,
    yearEndKind: entry.yearEndKind,
    days: centidaysToDays(entry.balanceDeltaCentidays),
    heldDays: centidaysToDays(entry.heldDeltaCentidays),
    effectiveDate: entry.effectiveDate,
    accrualPeriod: entry.accrualPeriod,
    payrollReference: entry.payrollReference,
    payrollMonth: entry.payrollMonth,
    note: entry.note,
    postedBySystem: entry.createdByUserId === null,
    leaveRequestId: entry.leaveRequestId?.toString() ?? null,
    createdAt: entry.createdAt,
  };
}

export function toBalanceFigures(balance) {
  const balanceCentidays = balance?.balanceCentidays ?? 0;
  const heldCentidays = balance?.heldCentidays ?? 0;
  return {
    balanceDays: centidaysToDays(balanceCentidays),
    heldDays: centidaysToDays(heldCentidays),
    availableDays: centidaysToDays(balanceCentidays - heldCentidays),
  };
}

/**
 * Balances of every leave type that keeps one: the active types, plus retired types the employee
 * still has a balance in for that year.
 * @param {{ employeeId: string, leaveYear: number|null, now?: Date }} input  null = current year
 */
export async function getEmployeeBalances({ employeeId, leaveYear, now }) {
  const { settings, today, currentLeaveYear } = await loadEmployeeLeaveContext(employeeId, { now });
  const year = leaveYear ?? currentLeaveYear;
  const [balances, movementTotals] = await Promise.all([
    LeaveBalance.find({ employeeId, leaveYear: year }).lean(),
    LeaveLedgerEntry.aggregate([
      // Aggregations do not cast, unlike find.
      { $match: { employeeId: new mongoose.Types.ObjectId(String(employeeId)), leaveYear: year } },
      {
        $group: {
          _id: {
            leaveTypeId: '$leaveTypeId',
            entryType: '$entryType',
            reasonCode: '$reasonCode',
            yearEndKind: '$yearEndKind',
          },
          totalCentidays: { $sum: '$balanceDeltaCentidays' },
        },
      },
    ]),
  ]);
  const balanceTypeIds = balances.map((balance) => balance.leaveTypeId);
  const leaveTypes = await LeaveType.find({
    tracksBalance: true,
    $or: [{ isActive: true }, { _id: { $in: balanceTypeIds } }],
  })
    .sort({ code: 1 })
    .lean();

  const balanceByTypeId = new Map(balances.map((balance) => [balance.leaveTypeId.toString(), balance]));
  const movementsByTypeId = new Map();
  for (const { _id: group, totalCentidays } of movementTotals) {
    const kind = movementKindOf(group);
    if (!kind) continue;
    const typeKey = group.leaveTypeId.toString();
    const movements = movementsByTypeId.get(typeKey) ?? emptyMovements();
    movements[kind] += totalCentidays;
    movementsByTypeId.set(typeKey, movements);
  }

  return {
    employeeId: employeeId.toString(),
    leaveYear: year,
    currentLeaveYear,
    today,
    leaveYearRange: leaveYearRange(year, settings.leaveYearStartMonth),
    balances: leaveTypes.map((leaveType) => {
      const typeKey = leaveType._id.toString();
      const movements = movementsByTypeId.get(typeKey) ?? emptyMovements();
      return {
        leaveType: { id: typeKey, code: leaveType.code, name: leaveType.name, isPaid: leaveType.isPaid },
        ...toBalanceFigures(balanceByTypeId.get(typeKey)),
        movements: Object.fromEntries(MOVEMENT_KINDS.map((kind) => [kind, centidaysToDays(movements[kind])])),
      };
    }),
  };
}

/**
 * The employee's ledger for a leave year (optionally one type), oldest first. A leave year holds a
 * bounded number of entries per employee, so it is returned whole.
 * @param {{ employeeId: string, leaveYear: number|null, leaveTypeId: string|null, now?: Date }} input
 */
export async function getEmployeeLedger({ employeeId, leaveYear, leaveTypeId, now }) {
  const { currentLeaveYear } = await loadEmployeeLeaveContext(employeeId, { now });
  const year = leaveYear ?? currentLeaveYear;
  const filter = { employeeId, leaveYear: year, ...(leaveTypeId ? { leaveTypeId } : {}) };
  const entries = await LeaveLedgerEntry.find(filter).sort({ createdAt: 1, _id: 1 }).lean();
  return { employeeId: employeeId.toString(), leaveYear: year, entries: entries.map(toLedgerEntrySummary) };
}
