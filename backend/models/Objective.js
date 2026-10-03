/**
 * Objective model: the "O" of an OKR for one quarter, at company or team level.
 *
 * Relationship vectors
 * --------------------
 *   Objective.parentObjectiveId ──► Objective._id        team objectives align to one company
 *                                                         objective of the same quarter (the
 *                                                         alignment canvas: company goal → team nodes);
 *                                                         null for company objectives
 *   Objective.departmentId      ──► Department._id       the team that owns a team objective;
 *                                                         null for company objectives
 *   Objective.ownerEmployeeId   ──► EmployeeProfile._id  accountable owner
 *   KeyResult.objectiveId       ──► Objective._id        (inverse; see KeyResult.js)
 *
 * Rules (enforced on save)
 *   company  no parent, no department
 *   team     a department and a parent that is an active company objective of the same quarter
 *   All referenced documents must exist. Objectives are archived, never deleted, so the history of a
 *   quarter stays intact. Changes go through save() with optimistic concurrency.
 *
 * Progress is not stored here: it is derived from the key results when read
 * (services/okrService.js), so it can never disagree with them.
 */

import mongoose from 'mongoose';
import { OKR_FIELD_LIMITS } from '../constants/validation.js';
import Department from './Department.js';
import EmployeeProfile from './EmployeeProfile.js';
import { assertReferenceExists } from './hierarchyIntegrity.js';

const { ObjectId } = mongoose.Schema.Types;

export const OBJECTIVE_LEVELS = Object.freeze({ COMPANY: 'company', TEAM: 'team' });
export const OKR_STATUSES = Object.freeze({ ACTIVE: 'active', ARCHIVED: 'archived' });

const objectiveSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, minlength: OKR_FIELD_LIMITS.TITLE_MIN_LENGTH, maxlength: OKR_FIELD_LIMITS.TITLE_MAX_LENGTH },
    description: { type: String, trim: true, maxlength: OKR_FIELD_LIMITS.DESCRIPTION_MAX_LENGTH, default: null },
    level: { type: String, enum: Object.values(OBJECTIVE_LEVELS), required: true, immutable: true },
    period: {
      year: { type: Number, required: true, min: 2000, max: 2100, immutable: true },
      quarter: { type: Number, required: true, min: 1, max: 4, immutable: true },
    },
    // ──► Objective._id (company objective), team objectives only
    parentObjectiveId: { type: ObjectId, ref: 'Objective', default: null, immutable: true },
    // ──► Department._id, team objectives only
    departmentId: { type: ObjectId, ref: 'Department', default: null, immutable: true },
    // ──► EmployeeProfile._id
    ownerEmployeeId: { type: ObjectId, ref: 'EmployeeProfile', required: true },
    status: { type: String, enum: Object.values(OKR_STATUSES), default: OKR_STATUSES.ACTIVE, required: true },
    // ──► User._id
    createdByUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);

// The alignment canvas for a quarter: company objectives, then team objectives under each.
objectiveSchema.index({ 'period.year': 1, 'period.quarter': 1, level: 1, status: 1 });
objectiveSchema.index({ parentObjectiveId: 1, status: 1 });
objectiveSchema.index({ departmentId: 1, 'period.year': 1, 'period.quarter': 1 });

objectiveSchema.pre('validate', async function enforceObjectiveStructure() {
  if (this.level === OBJECTIVE_LEVELS.COMPANY) {
    if (this.parentObjectiveId) this.invalidate('parentObjectiveId', 'A company objective cannot have a parent');
    if (this.departmentId) this.invalidate('departmentId', 'A company objective does not belong to a department');
  }
  if (this.level === OBJECTIVE_LEVELS.TEAM) {
    if (!this.departmentId) this.invalidate('departmentId', 'A team objective must belong to a department');
    if (!this.parentObjectiveId) this.invalidate('parentObjectiveId', 'A team objective must align to a company objective');
  }

  if (this.isModified('ownerEmployeeId')) {
    await assertReferenceExists({ model: EmployeeProfile, referencedId: this.ownerEmployeeId, entityLabel: 'Owner' });
  }
  if (this.isNew && this.departmentId) {
    await assertReferenceExists({ model: Department, referencedId: this.departmentId, entityLabel: 'Department' });
  }
  if (this.isNew && this.parentObjectiveId) {
    const parentObjective = await this.constructor.findById(this.parentObjectiveId).select('level period status').lean();
    if (!parentObjective) throw new Error(`Parent objective ${this.parentObjectiveId} does not exist`);
    if (parentObjective.level !== OBJECTIVE_LEVELS.COMPANY) throw new Error('A team objective must align to a company objective');
    if (parentObjective.status !== OKR_STATUSES.ACTIVE) throw new Error('A team objective cannot align to an archived company objective');
    if (parentObjective.period.year !== this.period.year || parentObjective.period.quarter !== this.period.quarter) {
      throw new Error('A team objective must be in the same quarter as its company objective');
    }
  }
});

const Objective = mongoose.model('Objective', objectiveSchema);

export default Objective;
