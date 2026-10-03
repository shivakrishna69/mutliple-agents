/**
 * KeyResult model: a measurable result under an Objective, with its milestones and progress log.
 *
 * Relationship vectors
 * --------------------
 *   KeyResult.objectiveId      ──► Objective._id        (many-to-one, immutable)
 *   KeyResult.ownerEmployeeId  ──► EmployeeProfile._id  the person who reports progress
 *   milestones[].completedByUserId / checkIns[].byUserId ──► User._id  (audit trail)
 *
 * Measurement
 *   startValue → targetValue, with currentValue moving between them. The target may be below the
 *   start (e.g. "reduce churn from 8% to 5%"). Progress is derived, never stored:
 *     progress% = clamp((current − start) / (target − start), 0, 1) × 100
 *   so it can never disagree with the values. A slider on the client sets either currentValue or a
 *   percentage that the service converts to currentValue.
 *
 * Milestones   up to 20 checkpoints (title, optional due date, pending/done with who and when).
 * Check-ins    every progress update is appended (value, note, who, when); the newest 50 are kept.
 *
 * Concurrency: optimistic concurrency on save(); clients send the version they edited, and a stale
 * version is rejected (409) instead of silently overwriting someone else's update.
 */

import mongoose from 'mongoose';
import { CALENDAR_DATE_PATTERN, OKR_FIELD_LIMITS } from '../constants/validation.js';
import EmployeeProfile from './EmployeeProfile.js';
import { assertReferenceExists } from './hierarchyIntegrity.js';
import { OKR_STATUSES } from './Objective.js';

const { ObjectId } = mongoose.Schema.Types;

export const KEY_RESULT_UNITS = Object.freeze({ PERCENT: 'percent', COUNT: 'count', CURRENCY_INR: 'currency_inr', SCORE: 'score' });
export const MILESTONE_STATUSES = Object.freeze({ PENDING: 'pending', DONE: 'done' });

const finiteNumber = (label) => ({
  type: Number,
  required: true,
  validate: { validator: Number.isFinite, message: `${label} must be a finite number` },
});

const milestoneSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, minlength: 1, maxlength: OKR_FIELD_LIMITS.TITLE_MAX_LENGTH },
  dueDate: { type: String, match: [CALENDAR_DATE_PATTERN, 'dueDate must be YYYY-MM-DD'], default: null },
  status: { type: String, enum: Object.values(MILESTONE_STATUSES), default: MILESTONE_STATUSES.PENDING, required: true },
  completedAt: { type: Date, default: null },
  // ──► User._id
  completedByUserId: { type: ObjectId, ref: 'User', default: null },
});

const checkInSchema = new mongoose.Schema(
  {
    value: finiteNumber('Check-in value'),
    note: { type: String, trim: true, maxlength: OKR_FIELD_LIMITS.CHECK_IN_NOTE_MAX_LENGTH, default: null },
    // ──► User._id
    byUserId: { type: ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const keyResultSchema = new mongoose.Schema(
  {
    // ──► Objective._id
    objectiveId: { type: ObjectId, ref: 'Objective', required: true, immutable: true },
    title: { type: String, required: true, trim: true, minlength: OKR_FIELD_LIMITS.TITLE_MIN_LENGTH, maxlength: OKR_FIELD_LIMITS.TITLE_MAX_LENGTH },
    // ──► EmployeeProfile._id
    ownerEmployeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true },
    unit: { type: String, enum: Object.values(KEY_RESULT_UNITS), required: true, immutable: true },
    startValue: { ...finiteNumber('startValue'), immutable: true },
    targetValue: finiteNumber('targetValue'),
    currentValue: finiteNumber('currentValue'),
    weight: { type: Number, min: 1, max: OKR_FIELD_LIMITS.MAX_WEIGHT, default: 1, validate: { validator: Number.isInteger, message: 'weight must be a whole number' } },
    milestones: { type: [milestoneSchema], validate: { validator: (milestones) => milestones.length <= OKR_FIELD_LIMITS.MAX_MILESTONES_PER_KEY_RESULT, message: `At most ${OKR_FIELD_LIMITS.MAX_MILESTONES_PER_KEY_RESULT} milestones` } },
    checkIns: { type: [checkInSchema], default: [] },
    status: { type: String, enum: Object.values(OKR_STATUSES), default: OKR_STATUSES.ACTIVE, required: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

keyResultSchema.index({ objectiveId: 1, status: 1 });
keyResultSchema.index({ ownerEmployeeId: 1, status: 1 });

/** Progress in percent, 0-100 with one decimal. */
export function computeKeyResultProgress({ startValue, targetValue, currentValue }) {
  const span = targetValue - startValue;
  if (span === 0) return currentValue === targetValue ? 100 : 0;
  const fraction = Math.min(1, Math.max(0, (currentValue - startValue) / span));
  return Math.round(fraction * 1000) / 10;
}

keyResultSchema.pre('validate', async function enforceKeyResultRules() {
  if (this.targetValue === this.startValue) this.invalidate('targetValue', 'targetValue must differ from startValue');
  if (this.unit === KEY_RESULT_UNITS.PERCENT) {
    for (const percentField of ['startValue', 'targetValue', 'currentValue']) {
      if (this[percentField] < 0 || this[percentField] > 100) this.invalidate(percentField, `${percentField} must be between 0 and 100 for a percent key result`);
    }
  }
  for (const milestone of this.milestones) {
    const isDone = milestone.status === MILESTONE_STATUSES.DONE;
    if (isDone !== Boolean(milestone.completedAt && milestone.completedByUserId)) {
      this.invalidate('milestones', 'A done milestone records who completed it and when; a pending one does not');
    }
  }
  // Keep only the newest check-ins.
  if (this.checkIns.length > OKR_FIELD_LIMITS.MAX_CHECK_INS_RETAINED) {
    this.checkIns.splice(0, this.checkIns.length - OKR_FIELD_LIMITS.MAX_CHECK_INS_RETAINED);
  }
  if (this.isModified('ownerEmployeeId')) {
    await assertReferenceExists({ model: EmployeeProfile, referencedId: this.ownerEmployeeId, entityLabel: 'Owner' });
  }
});

const KeyResult = mongoose.model('KeyResult', keyResultSchema);

export default KeyResult;
