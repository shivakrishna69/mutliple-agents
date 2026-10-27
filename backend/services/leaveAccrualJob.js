/**
 * The leave job: accrual credits and year-end movements for every employee, run at startup and
 * then periodically (startLeaveAccrualScheduler), and on demand by HR. It is idempotent: every
 * movement has a unique key in the ledger (models/LeaveLedgerEntry.js), so running it again, or on
 * several servers at once, never credits twice; it only posts what is due and not yet posted.
 *
 * For each employee who has not left, and each active leave type that keeps a balance:
 *   1. the previous leave year: accruals still due (for example the last END_OF_MONTH credit),
 *      unless its year end has already been posted; then its year end (carry forward, lapse or
 *      encashment), once the employee's date is in the new leave year;
 *   2. the current leave year: accruals due up to the employee's date.
 * "Today" is the employee's date in their office's time zone (company default without an office).
 * Accrual follows the employee's current employment status (services/leaveAccrualRules.js).
 * Only one leave year back is caught up, which covers any realistic gap between runs.
 */

import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import LeaveLedgerEntry, {
  ADJUSTMENT_REASON_CODES,
  CLOSING_YEAR_END_KINDS,
  LEDGER_ENTRY_TYPES,
  YEAR_END_KINDS,
} from '../models/LeaveLedgerEntry.js';
import LeaveBalance from '../models/LeaveBalance.js';
import LeaveType from '../models/LeaveType.js';
import OfficeLocation from '../models/OfficeLocation.js';
import { addDaysToCalendarDate, calendarDateOfUtcInstant } from '../utils/calendarDates.js';
import { daysToCentidays } from '../utils/leaveDays.js';
import { logger } from '../utils/logger.js';
import { dueAccrualCredits, isAccruingStatus, yearEndMovements } from './leaveAccrualRules.js';
import { postCredit } from './leaveLedger.js';
import { employeeToday, getLeaveSettings, leaveYearForDate } from './leaveSettings.js';
import { accrualPolicyOf } from './leaveTypes.js';
import { leaveYearRange } from './leaveYear.js';

/** How often the job runs. Hourly keeps joiner credits within an hour of the joining date. */
export const LEAVE_JOB_INTERVAL_MS = 60 * 60 * 1000;

const YEAR_END_PAYROLL_REFERENCE_PREFIX = 'YEAR-END-';

/** Payroll reference of the encashment a year end posts for a leave year. */
export const yearEndPayrollReference = (leaveYear) => `${YEAR_END_PAYROLL_REFERENCE_PREFIX}${leaveYear}`;

/** True for references reserved for year-end encashments, which HR cannot use by hand. */
export const isYearEndPayrollReference = (payrollReference) =>
  payrollReference.toUpperCase().startsWith(YEAR_END_PAYROLL_REFERENCE_PREFIX);

async function postAccruals({
  employeeId,
  leaveType,
  policy,
  joiningDate,
  leaveYear,
  settings,
  asOfDate,
  postedPeriods,
}) {
  const credits = dueAccrualCredits({
    policy,
    joiningDate,
    leaveYear,
    startMonth: settings.leaveYearStartMonth,
    asOfDate,
  });
  let posted = 0;
  for (const credit of credits) {
    if (postedPeriods.has(`${leaveType._id}:${credit.accrualPeriod}`)) continue;
    const { isNew } = await postCredit({
      employeeId,
      leaveTypeId: leaveType._id,
      leaveYear,
      entryType: LEDGER_ENTRY_TYPES.ACCRUAL,
      balanceDeltaCentidays: credit.amountCentidays,
      effectiveDate: credit.creditDate,
      accrualPeriod: credit.accrualPeriod,
    });
    if (isNew) posted += 1;
  }
  return posted;
}

/**
 * Year end of `leaveYear` for one employee and type. Sized from the balance as it stood before any
 * year-end movement, so a run that stopped half way finishes with the same figures.
 */
async function postYearEnd({ employeeId, leaveType, leaveYear, settings, postedYearEndKinds }) {
  const balance = await LeaveBalance.findOne({ employeeId, leaveTypeId: leaveType._id, leaveYear }).lean();
  const postedYearEndEntries = await LeaveLedgerEntry.find({
    employeeId,
    leaveTypeId: leaveType._id,
    leaveYear,
    yearEndKind: { $in: CLOSING_YEAR_END_KINDS },
  }).lean();
  const yearEndDeltaCentidays = postedYearEndEntries.reduce((total, entry) => total + entry.balanceDeltaCentidays, 0);
  const availableCentidays = (balance?.balanceCentidays ?? 0) - (balance?.heldCentidays ?? 0) - yearEndDeltaCentidays;
  const movements = yearEndMovements({
    availableCentidays,
    carryForwardCapCentidays:
      leaveType.carryForward.maxDays === null ? null : daysToCentidays(leaveType.carryForward.maxDays),
    excessAction: leaveType.carryForward.yearEndExcessAction,
  });
  const { lastDate } = leaveYearRange(leaveYear, settings.leaveYearStartMonth);
  const newYearFirstDate = addDaysToCalendarDate(lastDate, 1);
  const common = { employeeId, leaveTypeId: leaveType._id };
  const planned = [
    movements.carryForwardCentidays !== 0 && {
      ...common,
      leaveYear,
      entryType: LEDGER_ENTRY_TYPES.ADJUSTMENT,
      reasonCode: ADJUSTMENT_REASON_CODES.CARRY_FORWARD,
      yearEndKind: YEAR_END_KINDS.CARRY_FORWARD_OUT,
      balanceDeltaCentidays: -movements.carryForwardCentidays,
      effectiveDate: lastDate,
    },
    movements.carryForwardCentidays !== 0 && {
      ...common,
      leaveYear: leaveYear + 1,
      entryType: LEDGER_ENTRY_TYPES.ADJUSTMENT,
      reasonCode: ADJUSTMENT_REASON_CODES.CARRY_FORWARD,
      yearEndKind: YEAR_END_KINDS.CARRY_FORWARD_IN,
      balanceDeltaCentidays: movements.carryForwardCentidays,
      effectiveDate: newYearFirstDate,
    },
    movements.lapseCentidays > 0 && {
      ...common,
      leaveYear,
      entryType: LEDGER_ENTRY_TYPES.ADJUSTMENT,
      reasonCode: ADJUSTMENT_REASON_CODES.LAPSE,
      yearEndKind: YEAR_END_KINDS.LAPSE,
      balanceDeltaCentidays: -movements.lapseCentidays,
      effectiveDate: lastDate,
    },
    movements.encashCentidays > 0 && {
      ...common,
      leaveYear,
      entryType: LEDGER_ENTRY_TYPES.ENCASHMENT,
      yearEndKind: YEAR_END_KINDS.ENCASHMENT,
      balanceDeltaCentidays: -movements.encashCentidays,
      effectiveDate: lastDate,
      payrollReference: yearEndPayrollReference(leaveYear),
      // Paid in the first payroll of the new leave year.
      payrollMonth: newYearFirstDate.slice(0, 7),
    },
  ].filter(Boolean);
  let posted = 0;
  for (const movement of planned) {
    // CARRY_FORWARD_IN is filed under the next leave year; its key is checked there by the index.
    const alreadyPosted = movement.leaveYear === leaveYear && postedYearEndKinds.has(movement.yearEndKind);
    if (alreadyPosted) continue;
    const { isNew } = await postCredit(movement);
    if (isNew) posted += 1;
  }
  return posted;
}

/**
 * Runs the job for every employee.
 * @param {{ asOfDate?: string|null, now?: Date }} [options]  asOfDate replaces each employee's
 *   "today" (HR catch-up runs; never a future date, which the controller refuses).
 * @returns {Promise<{ employees: number, accrualsPosted: number, yearEndMovementsPosted: number }>}
 */
export async function runLeaveAccruals({ asOfDate = null, now = new Date() } = {}) {
  const settings = await getLeaveSettings();
  const leaveTypes = await LeaveType.find({ isActive: true, tracksBalance: true }).lean();
  const summary = { employees: 0, accrualsPosted: 0, yearEndMovementsPosted: 0 };
  if (leaveTypes.length === 0) return summary;

  const offices = await OfficeLocation.find({}).select('timeZone').lean();
  const timeZoneByOfficeId = new Map(offices.map((office) => [office._id.toString(), office.timeZone]));
  const employees = EmployeeProfile.find({
    'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
  })
    .select('organizationData.dateOfJoining organizationData.employmentStatus organizationData.officeLocationId')
    .lean()
    .cursor();

  for await (const employee of employees) {
    const { dateOfJoining, employmentStatus, officeLocationId } = employee.organizationData;
    const joiningDate = calendarDateOfUtcInstant(dateOfJoining);
    const today =
      asOfDate ??
      employeeToday({ officeTimeZone: timeZoneByOfficeId.get(officeLocationId?.toString()), settings, now });
    if (joiningDate > today) continue;
    summary.employees += 1;
    const currentLeaveYear = leaveYearForDate(today, settings);
    const previousLeaveYear = currentLeaveYear - 1;
    const previousYearRange = leaveYearRange(previousLeaveYear, settings.leaveYearStartMonth);

    const existingEntries = await LeaveLedgerEntry.find({
      employeeId: employee._id,
      leaveYear: { $in: [previousLeaveYear, currentLeaveYear] },
      $or: [{ entryType: LEDGER_ENTRY_TYPES.ACCRUAL }, { yearEndKind: { $type: 'string' } }],
    })
      .select('leaveTypeId leaveYear accrualPeriod yearEndKind')
      .lean();
    const postedPeriods = new Set(
      existingEntries
        .filter((entry) => entry.accrualPeriod)
        .map((entry) => `${entry.leaveTypeId}:${entry.accrualPeriod}`),
    );
    const yearEndKindsByType = (leaveTypeId) =>
      new Set(
        existingEntries
          .filter(
            (entry) =>
              CLOSING_YEAR_END_KINDS.includes(entry.yearEndKind) &&
              entry.leaveYear === previousLeaveYear &&
              entry.leaveTypeId.toString() === leaveTypeId.toString(),
          )
          .map((entry) => entry.yearEndKind),
      );

    for (const leaveType of leaveTypes) {
      const policy = accrualPolicyOf(leaveType);
      const accrues = isAccruingStatus(employmentStatus, policy);
      const accrualInput = { employeeId: employee._id, leaveType, policy, joiningDate, settings, postedPeriods };

      if (joiningDate <= previousYearRange.lastDate) {
        const postedYearEndKinds = yearEndKindsByType(leaveType._id);
        if (accrues && postedYearEndKinds.size === 0) {
          summary.accrualsPosted += await postAccruals({
            ...accrualInput,
            leaveYear: previousLeaveYear,
            asOfDate: previousYearRange.lastDate,
          });
        }
        summary.yearEndMovementsPosted += await postYearEnd({
          employeeId: employee._id,
          leaveType,
          leaveYear: previousLeaveYear,
          settings,
          postedYearEndKinds,
        });
      }
      if (accrues) {
        summary.accrualsPosted += await postAccruals({ ...accrualInput, leaveYear: currentLeaveYear, asOfDate: today });
      }
    }
  }
  return summary;
}

let schedulerTimer = null;

/** Runs the job now and then every LEAVE_JOB_INTERVAL_MS; failures are logged, never thrown. */
export function startLeaveAccrualScheduler() {
  if (schedulerTimer) return;
  const runAndLog = async () => {
    try {
      const summary = await runLeaveAccruals();
      if (summary.accrualsPosted + summary.yearEndMovementsPosted > 0)
        logger.info('Leave job posted movements', summary);
    } catch (jobError) {
      logger.error('Leave job failed', {
        error: { name: jobError.name, message: jobError.message, stack: jobError.stack },
      });
    }
  };
  runAndLog();
  schedulerTimer = setInterval(runAndLog, LEAVE_JOB_INTERVAL_MS);
  schedulerTimer.unref();
}

export function stopLeaveAccrualScheduler() {
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}
