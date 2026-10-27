/**
 * LeaveType: one kind of leave and its whole policy, set by HR. Every rule is data here, so each
 * company configures its own; nothing about a policy is a constant in code. A type is retired by
 * setting isActive false, never deleted, because ledger entries and balances refer to it.
 *
 *   isPaid / tracksBalance   Loss of Pay is unpaid and keeps no balance; other types keep one.
 *   accrual                  method MONTHLY | UPFRONT_YEARLY | NONE, the annual quota, when monthly
 *                            credits land (START_OF_MONTH | END_OF_MONTH) and the step a joiner's
 *                            pro-rata credit is rounded to (services/leaveAccrualRules.js).
 *                            NONE suits entitlements HR grants per person (e.g. maternity leave).
 *   accrueDuringNotice       whether accrual continues while the employee serves notice.
 *   carryForward             cap on what moves to the next leave year (null = no cap) and what
 *                            happens to the rest: LAPSE or ENCASH.
 *   encashment               whether HR may encash it, and the days that must remain afterwards.
 *   usage                    rules applied when employees apply (Phase 3): sandwich rule, half
 *                            days, longest single leave, notice, how many days back a request may
 *                            start (applying after the fact, e.g. sick leave), who may use it,
 *                            minimum service, when an attachment is needed, and whether the
 *                            balance may go negative.
 *
 * Day values are in days, in half-day steps; services convert them to centidays.
 */

import mongoose from 'mongoose';
import { LEAVE_LIMITS } from '../constants/validation.js';
import { EMPLOYMENT_STATUSES } from './EmployeeProfile.js';

export const ACCRUAL_METHODS = Object.freeze({ MONTHLY: 'MONTHLY', UPFRONT_YEARLY: 'UPFRONT_YEARLY', NONE: 'NONE' });
export const ACCRUAL_TIMINGS = Object.freeze({ START_OF_MONTH: 'START_OF_MONTH', END_OF_MONTH: 'END_OF_MONTH' });
export const YEAR_END_EXCESS_ACTIONS = Object.freeze({ LAPSE: 'LAPSE', ENCASH: 'ENCASH' });

const { ObjectId } = mongoose.Schema.Types;
const LIMITS = LEAVE_LIMITS;
const POLICY_DAY_STEP = LIMITS.POLICY_DAY_STEP_CENTIDAYS / LIMITS.CENTIDAYS_PER_DAY;

/** Employment statuses that may use a new type unless HR narrows them. */
export const DEFAULT_ELIGIBLE_STATUSES = Object.freeze([
  EMPLOYMENT_STATUSES.PROBATION,
  EMPLOYMENT_STATUSES.ACTIVE,
  EMPLOYMENT_STATUSES.NOTICE,
]);

const isPolicyDays = (maximum) => (days) =>
  typeof days === 'number' &&
  days >= 0 &&
  days <= maximum &&
  Number.isInteger(Math.round(days * LIMITS.CENTIDAYS_PER_DAY) / LIMITS.POLICY_DAY_STEP_CENTIDAYS);

const policyDaysField = ({ maximum = LIMITS.MAX_POLICY_DAYS, defaultValue = 0, allowNull = false } = {}) => ({
  type: Number,
  default: defaultValue,
  validate: {
    validator: (days) => (allowNull && days === null) || isPolicyDays(maximum)(days),
    message: `{PATH} must be 0 to ${maximum} days in steps of ${POLICY_DAY_STEP}${allowNull ? ', or empty for no limit' : ''}`,
  },
});

const leaveTypeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Leave type code is required'],
      unique: true,
      immutable: true,
      trim: true,
      uppercase: true,
      match: [LIMITS.TYPE_CODE_PATTERN, 'Leave type code must be 2-20 letters, digits or "_", starting with a letter'],
    },
    name: {
      type: String,
      required: [true, 'Leave type name is required'],
      trim: true,
      minlength: LIMITS.TYPE_NAME_MIN_LENGTH,
      maxlength: LIMITS.TYPE_NAME_MAX_LENGTH,
    },
    description: { type: String, trim: true, maxlength: LIMITS.TYPE_DESCRIPTION_MAX_LENGTH, default: '' },
    isPaid: { type: Boolean, required: [true, 'Say whether the leave is paid'] },
    tracksBalance: { type: Boolean, default: true },
    accrual: {
      method: { type: String, enum: Object.values(ACCRUAL_METHODS), default: ACCRUAL_METHODS.NONE },
      annualQuotaDays: policyDaysField({ maximum: LIMITS.MAX_ANNUAL_QUOTA_DAYS }),
      timing: { type: String, enum: Object.values(ACCRUAL_TIMINGS), default: ACCRUAL_TIMINGS.START_OF_MONTH },
      proRataRoundingStepDays: {
        type: Number,
        default: POLICY_DAY_STEP,
        enum: LIMITS.PRO_RATA_ROUNDING_STEP_CENTIDAYS.map((step) => step / LIMITS.CENTIDAYS_PER_DAY),
      },
    },
    accrueDuringNotice: { type: Boolean, default: true },
    carryForward: {
      maxDays: policyDaysField({ allowNull: true }),
      yearEndExcessAction: {
        type: String,
        enum: Object.values(YEAR_END_EXCESS_ACTIONS),
        default: YEAR_END_EXCESS_ACTIONS.LAPSE,
      },
    },
    encashment: {
      isEncashable: { type: Boolean, default: false },
      minBalanceRetainedDays: policyDaysField(),
    },
    usage: {
      sandwichRule: { type: Boolean, default: false },
      allowHalfDay: { type: Boolean, default: true },
      maxConsecutiveDays: policyDaysField({ allowNull: true, defaultValue: null }),
      minNoticeDays: policyDaysField(),
      maxBackdatedDays: policyDaysField(),
      eligibleEmploymentStatuses: {
        type: [{ type: String, enum: Object.values(EMPLOYMENT_STATUSES) }],
        default: () => [...DEFAULT_ELIGIBLE_STATUSES],
      },
      minServiceDays: policyDaysField(),
      attachmentRequiredAfterDays: policyDaysField({ allowNull: true, defaultValue: null }),
      allowNegativeBalance: { type: Boolean, default: false },
      maxNegativeDays: policyDaysField(),
    },
    isActive: { type: Boolean, default: true },
    // null for types seeded from a template.
    createdByUserId: { type: ObjectId, ref: 'User', default: null, immutable: true },
    updatedByUserId: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, optimisticConcurrency: true },
);

leaveTypeSchema.pre('validate', function enforcePolicyConsistency() {
  if (!this.tracksBalance) {
    if (this.accrual.method !== ACCRUAL_METHODS.NONE || this.accrual.annualQuotaDays > 0) {
      this.invalidate('accrual.method', 'A leave type without a balance cannot accrue');
    }
    if (this.encashment.isEncashable) {
      this.invalidate('encashment.isEncashable', 'A leave type without a balance cannot be encashed');
    }
    if (this.isPaid) this.invalidate('tracksBalance', 'Paid leave must keep a balance');
  }
  if (this.accrual.method === ACCRUAL_METHODS.NONE && this.accrual.annualQuotaDays > 0) {
    this.invalidate('accrual.annualQuotaDays', 'A quota needs an accrual method (monthly or upfront)');
  }
  if (!this.usage.allowNegativeBalance && this.usage.maxNegativeDays > 0) {
    this.invalidate('usage.maxNegativeDays', 'A negative limit needs allowNegativeBalance');
  }
  if (this.usage.eligibleEmploymentStatuses.includes(EMPLOYMENT_STATUSES.TERMINATED)) {
    this.invalidate('usage.eligibleEmploymentStatuses', 'Terminated employees cannot take leave');
  }
});

export default mongoose.model('LeaveType', leaveTypeSchema);
