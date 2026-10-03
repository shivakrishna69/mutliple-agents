/**
 * Department model: one unit of the organisation chart. Departments nest to any depth
 * (Company -> Division -> Department -> Team) through `parentDepartmentId`.
 *
 * Relationship vectors
 * --------------------
 *   Department.parentDepartmentId  ──► Department._id        (many-to-one, self-reference)
 *       The unit this one sits under. null = a top-level unit (root of a tree). Walking this
 *       pointer upward gives the chain of ownership ("which division owns this team"); walking
 *       it downward (children of X) uses the { parentDepartmentId, name } index.
 *       Integrity: must exist, must not be the department itself, and must not create a loop
 *       (A under B under A); checked on save by hierarchyIntegrity.assertParentKeepsTreeAcyclic.
 *
 *   Department.departmentHeadId    ──► EmployeeProfile._id   (many-to-one, optional)
 *       The employee accountable for the unit. Points at the HR profile, not the login account
 *       (User), because headship is an organisational fact that outlives credential changes.
 *       One employee may head several units (e.g. an interim head of two teams).
 *       Integrity: must reference an existing profile; checked on save.
 *
 *   EmployeeProfile.organizationData.departmentId ──► Department._id   (inverse, see EmployeeProfile.js)
 *       Membership lives on the employee, never as an array on the department, so a department
 *       document stays small no matter how many people it has, and moving a person is one write.
 *
 * Identifiers
 * -----------
 *   `code` is the stable business key ("ENG", "FIN-AP") used by finance and integrations; it is
 *   unique across the organisation and stored uppercase. `name` is the display label and only
 *   needs to be unique among siblings (two divisions may each have a "Platform" team).
 *   `budgetCode` is the finance cost centre the unit's spend is booked against; several units
 *   may share one, so it is not unique.
 *
 * Write rules
 * -----------
 *   The hierarchy pointers (parentDepartmentId, departmentHeadId) are validated in document
 *   middleware, which query-style updates skip; query updates touching them are therefore
 *   rejected. Change them by loading the document, assigning, and calling save().
 *   Deleting a department that still has children or members is an application-level decision
 *   (reassign first); this model does not cascade.
 */

import mongoose from 'mongoose';
import { BUDGET_CODE_PATTERN, DEPARTMENT_CODE_PATTERN, ORGANIZATION_FIELD_LIMITS } from '../constants/validation.js';
import {
  QUERY_UPDATE_OPERATIONS,
  assertParentKeepsTreeAcyclic,
  assertReferenceExists,
  createGuardedFieldUpdateBlocker,
} from './hierarchyIntegrity.js';

const { ObjectId } = mongoose.Schema.Types;

const departmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Department name is required'],
      trim: true,
      minlength: 1,
      maxlength: ORGANIZATION_FIELD_LIMITS.DEPARTMENT_NAME_MAX_LENGTH,
    },
    code: {
      type: String,
      required: [true, 'Department code is required'],
      unique: true,
      trim: true,
      uppercase: true,
      match: [DEPARTMENT_CODE_PATTERN, 'Department code "{VALUE}" must be 2–20 letters, digits, "-" or "_"'],
    },
    // ──► EmployeeProfile._id. Optional: a newly created unit may not have a head yet.
    departmentHeadId: {
      type: ObjectId,
      ref: 'EmployeeProfile',
      default: null,
    },
    budgetCode: {
      type: String,
      required: [true, 'Budget code is required'],
      trim: true,
      uppercase: true,
      match: [BUDGET_CODE_PATTERN, 'Budget code "{VALUE}" is not valid'],
    },
    // ──► Department._id (self). null marks a top-level unit.
    parentDepartmentId: {
      type: ObjectId,
      ref: 'Department',
      default: null,
      validate: {
        validator(parentDepartmentId) {
          return !parentDepartmentId || !parentDepartmentId.equals(this._id);
        },
        message: 'A department cannot be its own parent',
      },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// `unique: true` on `code` creates the business-key index.

// Children of a department, sorted by name (org-chart rendering, downward $graphLookup with
// connectToField "parentDepartmentId"). Unique so siblings cannot share a display name; root
// units (parent null) are siblings of each other under this rule.
departmentSchema.index({ parentDepartmentId: 1, name: 1 }, { unique: true });

// "Which units does this person head?" Partial: units without a head are not indexed.
departmentSchema.index({ departmentHeadId: 1 }, { partialFilterExpression: { departmentHeadId: { $type: 'objectId' } } });

// ---------------------------------------------------------------------------
// Referential integrity
// ---------------------------------------------------------------------------

departmentSchema.pre('validate', async function enforceHierarchyIntegrity() {
  if (this.isModified('parentDepartmentId') && this.parentDepartmentId && !this.parentDepartmentId.equals(this._id)) {
    await assertParentKeepsTreeAcyclic({
      model: this.constructor,
      documentId: this._id,
      proposedParentId: this.parentDepartmentId,
      parentFieldPath: 'parentDepartmentId',
      maxDepth: ORGANIZATION_FIELD_LIMITS.HIERARCHY_MAX_DEPTH,
      entityLabel: 'Parent department',
    });
  }

  if (this.isModified('departmentHeadId') && this.departmentHeadId) {
    // Resolved lazily: EmployeeProfile.js also references Department, so a top-level import
    // would be circular.
    await assertReferenceExists({ model: mongoose.model('EmployeeProfile'), referencedId: this.departmentHeadId, entityLabel: 'Department head' });
  }
});

departmentSchema.pre(QUERY_UPDATE_OPERATIONS, createGuardedFieldUpdateBlocker('Department', ['parentDepartmentId', 'departmentHeadId']));

const Department = mongoose.model('Department', departmentSchema);

export default Department;
