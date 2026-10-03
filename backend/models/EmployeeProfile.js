/**
 * EmployeeProfile model: the HR record of one employee. Authentication stays in User
 * (credentials, role); everything about the person's place in the organisation lives here.
 *
 * Relationship vectors
 * --------------------
 *   EmployeeProfile.userId                          ──► User._id            (one-to-one)
 *       The login account this profile belongs to. Unique: one profile per account. The link
 *       lets a signed-in session resolve "my profile" (and later "my payslips") from req.user.id
 *       without trusting anything the client sends.
 *
 *   EmployeeProfile.organizationData.departmentId    ──► Department._id     (many-to-one)
 *       The unit the employee belongs to. Membership is stored here, on the employee, rather
 *       than as a member array on Department, so departments stay small and a transfer is a
 *       single-document write. The department tree above it is reached through
 *       Department.parentDepartmentId.
 *
 *   EmployeeProfile.organizationData.reportingManagerId ──► EmployeeProfile._id  (many-to-one, self-reference)
 *       The employee's line manager. null = top of the chain (e.g. the CEO). Walking it upward
 *       gives the management chain (skip-level, approval routing); walking it downward gives
 *       direct and indirect reports. Integrity: must exist, must not be the employee, and must
 *       not create a loop; checked on save.
 *
 *   Department.departmentHeadId                     ──► EmployeeProfile._id  (inverse, see Department.js)
 *       A profile may head zero or more departments. The head is not required to be a member of
 *       the department they head (e.g. a division head who sits in the parent unit).
 *
 *   EmployeeProfile.organizationData.officeLocationId ──► OfficeLocation._id  (many-to-one, optional)
 *       The employee's base office: the geofence centre for attendance punches and the source of
 *       the local time zone and shift rules (see OfficeLocation.js). Required before the employee
 *       can punch in; checked to exist on save.
 *
 * Reporting lines and departments are independent: a manager may sit in another department
 * (matrix organisations), so neither pointer is derived from the other.
 *
 * Graph traversal patterns these indexes serve
 * --------------------------------------------
 *   Direct reports by status        find({ 'organizationData.reportingManagerId': M, 'organizationData.employmentStatus': S })
 *                                   -> { reportingManagerId, employmentStatus }
 *   Whole subtree under a manager   $graphLookup connectFromField "_id", connectToField
 *                                   "organizationData.reportingManagerId": each hop is an equality
 *                                   lookup on the reportingManagerId prefix of the same index.
 *   Management chain upward         $graphLookup connectFromField "organizationData.reportingManagerId",
 *                                   connectToField "_id": served by the _id index.
 *   Department roster / headcount   find({ departmentId: D, employmentStatus: S }) and aggregations
 *                                   grouping a department by manager
 *                                   -> { departmentId, employmentStatus, reportingManagerId }
 *   Fields follow the equality-sort-range rule: the equality filters come first, and the last key
 *   lets a department's org chart be read in manager order straight from the index.
 *
 * Sensitive data
 * --------------
 *   `biometricMetadata` (location-binding data) and `advancedMetrics` (inferred wellbeing and
 *   attrition scores) are personal data under India's DPDP Act 2023 and comparable laws.
 *   Every leaf has `select: false`, so ordinary queries never load them; HR code must ask with
 *   `.select('+biometricMetadata.allowedGeofenceRadius')` etc. `toJSON` also strips both groups
 *   as a second guard, so a document loaded with them cannot leak them by being serialised into
 *   a response; endpoints that are allowed to return them must map the fields explicitly.
 *   Never send these fields to the AI service.
 *
 * Write rules
 * -----------
 *   userId, departmentId, reportingManagerId and officeLocationId are validated in document middleware, which
 *   query-style updates skip; query updates touching them are rejected. Change them by loading
 *   the profile, assigning, and calling save().
 */

import mongoose from 'mongoose';
import { MAC_ADDRESS_PATTERN, ORGANIZATION_FIELD_LIMITS } from '../constants/validation.js';
import { invalidateOrgHierarchyCache } from '../services/orgHierarchyCache.js';
import Department from './Department.js';
import OfficeLocation from './OfficeLocation.js';
import User from './User.js';
import {
  QUERY_UPDATE_OPERATIONS,
  assertParentKeepsTreeAcyclic,
  assertReferenceExists,
  createGuardedFieldUpdateBlocker,
} from './hierarchyIntegrity.js';

const { ObjectId } = mongoose.Schema.Types;
const LIMITS = ORGANIZATION_FIELD_LIMITS;

/** Allowed values for organizationData.workLocationType. */
export const WORK_LOCATION_TYPES = Object.freeze({
  REMOTE: 'Remote',
  HYBRID: 'Hybrid',
  ONSITE: 'Onsite',
});

/**
 * Allowed values for organizationData.employmentStatus.
 *   Probation   newly joined, under review (the default for a new profile)
 *   Active      confirmed employee
 *   Notice      resigned or let go, serving the notice period
 *   Terminated  no longer employed; the profile is kept for records and payroll history
 */
export const EMPLOYMENT_STATUSES = Object.freeze({
  PROBATION: 'Probation',
  ACTIVE: 'Active',
  NOTICE: 'Notice',
  TERMINATED: 'Terminated',
});

/**
 * MAC value that iOS (since 7) and Android (since 6) return to apps instead of the real hardware
 * address. Storing it would bind every such phone to "the same device", so it is rejected.
 */
export const PLACEHOLDER_MAC_ADDRESS = '02:00:00:00:00:00';

/** "3c-22-fb-7a-10-9e" / "3c:22:fb:7a:10:9e" -> "3C:22:FB:7A:10:9E"; other shapes are left for the validator to reject. */
export function normalizeMacAddress(rawMacAddress) {
  if (typeof rawMacAddress !== 'string') return rawMacAddress;
  return rawMacAddress.trim().toUpperCase().replace(/-/g, ':');
}

const scoreField = (label) => ({
  type: Number,
  min: [LIMITS.SCORE_MIN, `${label} cannot be below ${LIMITS.SCORE_MIN}`],
  max: [LIMITS.SCORE_MAX, `${label} cannot exceed ${LIMITS.SCORE_MAX}`],
  default: 0,
  select: false,
});

const employeeProfileSchema = new mongoose.Schema(
  {
    // ──► User._id (one-to-one; the unique index enforces "one profile per account").
    userId: {
      type: ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      unique: true,
      immutable: true,
    },

    organizationData: {
      designation: {
        type: String,
        required: [true, 'Designation is required'],
        trim: true,
        minlength: 1,
        maxlength: LIMITS.DESIGNATION_MAX_LENGTH,
      },
      // ──► Department._id
      departmentId: {
        type: ObjectId,
        ref: 'Department',
        required: [true, 'Department is required'],
      },
      // ──► EmployeeProfile._id (self). null = top of the reporting chain.
      reportingManagerId: {
        type: ObjectId,
        ref: 'EmployeeProfile',
        default: null,
        validate: {
          validator(reportingManagerId) {
            // `this` is the document on save(); ownerDocument() reaches it from a nested path.
            const profileDocument = typeof this.ownerDocument === 'function' ? this.ownerDocument() : this;
            return !reportingManagerId || !reportingManagerId.equals(profileDocument._id);
          },
          message: 'An employee cannot report to themselves',
        },
      },
      // ──► OfficeLocation._id. null until HR assigns a base office.
      officeLocationId: {
        type: ObjectId,
        ref: 'OfficeLocation',
        default: null,
      },
      workLocationType: {
        type: String,
        enum: { values: Object.values(WORK_LOCATION_TYPES), message: 'Work location type "{VALUE}" is not valid' },
        required: [true, 'Work location type is required'],
      },
      // May be in the future: a profile is created when an offer is accepted, before day one.
      dateOfJoining: {
        type: Date,
        required: [true, 'Date of joining is required'],
      },
      employmentStatus: {
        type: String,
        enum: { values: Object.values(EMPLOYMENT_STATUSES), message: 'Employment status "{VALUE}" is not valid' },
        required: true,
        default: EMPLOYMENT_STATUSES.PROBATION,
      },
    },

    /**
     * Attendance binding. Both fields are optional (remote staff usually have neither).
     *
     * Note on `registeredDeviceMacAddress`: browsers never expose a MAC address, and current
     * iOS / Android give apps a placeholder or a per-network randomised one. A value here is only
     * trustworthy when captured by a managed-device (MDM) agent or a corporate network
     * controller. For phone or web check-in, bind the device with a WebAuthn / passkey
     * credential instead.
     */
    biometricMetadata: {
      // Radius in metres around the assigned work site within which check-in is accepted.
      allowedGeofenceRadius: {
        type: Number,
        min: [LIMITS.GEOFENCE_RADIUS_MIN_METRES, `Geofence radius must be at least ${LIMITS.GEOFENCE_RADIUS_MIN_METRES} m`],
        max: [LIMITS.GEOFENCE_RADIUS_MAX_METRES, `Geofence radius cannot exceed ${LIMITS.GEOFENCE_RADIUS_MAX_METRES} m`],
        default: null,
        select: false,
      },
      registeredDeviceMacAddress: {
        type: String,
        set: normalizeMacAddress,
        default: null,
        select: false,
        validate: [
          { validator: (macAddress) => macAddress === null || MAC_ADDRESS_PATTERN.test(macAddress), message: 'Device MAC address "{VALUE}" is not a valid MAC-48 address' },
          { validator: (macAddress) => macAddress !== PLACEHOLDER_MAC_ADDRESS, message: 'This MAC address is a mobile OS placeholder, not a real device address' },
        ],
      },
    },

    /**
     * Model-derived scores, 0 (lowest) to 100 (highest risk), written by an analytics job, never
     * by the employee. Decision support for HR only: they must not drive automated decisions
     * about an individual.
     */
    advancedMetrics: {
      currentBurnoutScore: scoreField('Burnout score'),
      attritionRiskIndex: scoreField('Attrition risk index'),
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.biometricMetadata;
        delete ret.advancedMetrics;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// `unique: true` on userId creates the "profile for this account" index.

// Department roster by status, ordered by manager (see "Graph traversal patterns" above).
employeeProfileSchema.index({
  'organizationData.departmentId': 1,
  'organizationData.employmentStatus': 1,
  'organizationData.reportingManagerId': 1,
});

// Direct reports (optionally by status) and every downward $graphLookup hop.
employeeProfileSchema.index({
  'organizationData.reportingManagerId': 1,
  'organizationData.employmentStatus': 1,
});

// ---------------------------------------------------------------------------
// Referential integrity
// ---------------------------------------------------------------------------

employeeProfileSchema.pre('validate', async function enforceReferences() {
  if (this.isNew) {
    await assertReferenceExists({ model: User, referencedId: this.userId, entityLabel: 'User' });
  }

  if (this.isModified('organizationData.departmentId') && this.organizationData?.departmentId) {
    await assertReferenceExists({ model: Department, referencedId: this.organizationData.departmentId, entityLabel: 'Department' });
  }

  if (this.isModified('organizationData.officeLocationId') && this.organizationData?.officeLocationId) {
    await assertReferenceExists({ model: OfficeLocation, referencedId: this.organizationData.officeLocationId, entityLabel: 'Office location' });
  }

  const reportingManagerId = this.organizationData?.reportingManagerId;
  if (this.isModified('organizationData.reportingManagerId') && reportingManagerId && !reportingManagerId.equals(this._id)) {
    await assertParentKeepsTreeAcyclic({
      model: this.constructor,
      documentId: this._id,
      proposedParentId: reportingManagerId,
      parentFieldPath: 'organizationData.reportingManagerId',
      maxDepth: LIMITS.HIERARCHY_MAX_DEPTH,
      entityLabel: 'Reporting manager',
    });
  }
});

employeeProfileSchema.pre(
  QUERY_UPDATE_OPERATIONS,
  createGuardedFieldUpdateBlocker('EmployeeProfile', ['userId', 'organizationData.departmentId', 'organizationData.reportingManagerId', 'organizationData.officeLocationId']),
);

// ---------------------------------------------------------------------------
// Org chart cache invalidation
// ---------------------------------------------------------------------------

/**
 * The cached org hierarchy (services/orgHierarchyService.js) is built from these documents, so any
 * write marks it stale. The hooks are awaited (one Redis INCR, time-bounded, never throws), so a
 * client that saves and then reloads the chart sees its own change. Writes that bypass Mongoose
 * are covered only by the snapshot TTL.
 */
const PROFILE_WRITE_QUERY_OPERATIONS = [...QUERY_UPDATE_OPERATIONS, 'deleteOne', 'deleteMany', 'findOneAndDelete'];

employeeProfileSchema.post('save', async function invalidateOrgChartAfterSave() {
  await invalidateOrgHierarchyCache('employee profile saved');
});
employeeProfileSchema.post('deleteOne', { document: true, query: false }, async function invalidateOrgChartAfterDocumentDelete() {
  await invalidateOrgHierarchyCache('employee profile deleted');
});
employeeProfileSchema.post(PROFILE_WRITE_QUERY_OPERATIONS, async function invalidateOrgChartAfterQueryWrite() {
  await invalidateOrgHierarchyCache(`employee profile ${this.op}`);
});
employeeProfileSchema.post('insertMany', async function invalidateOrgChartAfterBulkInsert() {
  await invalidateOrgHierarchyCache('employee profiles inserted');
});

const EmployeeProfile = mongoose.model('EmployeeProfile', employeeProfileSchema);

export default EmployeeProfile;
