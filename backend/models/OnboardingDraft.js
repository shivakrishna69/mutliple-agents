/**
 * OnboardingDraft: an offer prepared by HR, waiting for a person to review and send it (human in
 * the loop). Nothing reaches the candidate until someone dispatches it.
 *
 *   PENDING_REVIEW ──edit──► PENDING_REVIEW
 *        │   └──cancel──► CANCELLED
 *        └──dispatch──► DISPATCHING ──► DISPATCHED      (employee provisioned, email sent)
 *                            └──────► DISPATCH_FAILED  (employee provisioned, email not sent;
 *                                                       dispatch again resends the same offer)
 *
 * The move to DISPATCHING is one conditional update (status must still be PENDING_REVIEW or
 * DISPATCH_FAILED), so two people pressing "send" at the same moment cannot both send.
 *
 *   candidate      who the offer is for; dateOfBirth also opens the final letter (DDMMYYYY)
 *   position       the employee record the dispatch creates (as an HR invitation would)
 *   compensation   the inputs of services/ctcStructure.js
 *   structure      the salary structure computed when the draft was saved, with the
 *                  settingsVersion it was computed under. Dispatch recomputes it and refuses when
 *                  it differs, so nobody sends figures they did not review.
 *   dispatch       who sent it and when, the employee it created, and the SHA-256 of the letter
 */

import mongoose from 'mongoose';
import { DEFAULT_EMPLOYMENT_TYPE, DEFAULT_JOB_LEVEL, EMPLOYMENT_TYPES, JOB_LEVELS } from '../constants/accessRoles.js';
import { GENDERS } from '../constants/validation.js';
import { PROFESSIONAL_TAX_STATES, TAX_REGIMES } from '../utils/payroll/rules.js';
import { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from './EmployeeProfile.js';
import { INVITABLE_ROLES } from './EmployeeInvitation.js';

const { ObjectId } = mongoose.Schema.Types;

export const DRAFT_STATUSES = Object.freeze({
  PENDING_REVIEW: 'PENDING_REVIEW',
  DISPATCHING: 'DISPATCHING',
  DISPATCHED: 'DISPATCHED',
  DISPATCH_FAILED: 'DISPATCH_FAILED',
  CANCELLED: 'CANCELLED',
});

/** States from which a draft may be sent. */
export const DISPATCHABLE_STATUSES = Object.freeze([DRAFT_STATUSES.PENDING_REVIEW, DRAFT_STATUSES.DISPATCH_FAILED]);

const onboardingDraftSchema = new mongoose.Schema(
  {
    candidate: {
      name: { type: String, required: true, trim: true },
      personalEmail: { type: String, required: true, trim: true, lowercase: true },
      companyEmail: { type: String, trim: true, lowercase: true, default: null },
      dateOfBirth: { type: Date, required: true },
      gender: { type: String, enum: [...Object.values(GENDERS), null], default: null },
    },
    position: {
      role: { type: String, enum: INVITABLE_ROLES, required: true },
      designation: { type: String, required: true, trim: true },
      departmentId: { type: ObjectId, ref: 'Department', required: true },
      reportingManagerId: { type: ObjectId, ref: 'EmployeeProfile', default: null },
      workLocationType: { type: String, enum: Object.values(WORK_LOCATION_TYPES), required: true },
      dateOfJoining: { type: Date, required: true },
      employmentStatus: { type: String, enum: Object.values(EMPLOYMENT_STATUSES), required: true },
      // Who the person is in the company (constants/accessRoles.js): for display and reports only; it
      // grants nothing (approvals follow reporting lines and department heads).
      jobLevel: { type: String, enum: JOB_LEVELS, default: DEFAULT_JOB_LEVEL, required: true },
      employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: DEFAULT_EMPLOYMENT_TYPE, required: true },
    },
    compensation: {
      annualCtc: { type: Number, required: true },
      taxRegime: { type: String, enum: Object.values(TAX_REGIMES), required: true },
      workCity: { type: String, required: true, trim: true },
      professionalTaxState: { type: String, enum: Object.values(PROFESSIONAL_TAX_STATES), required: true },
    },
    structure: { type: mongoose.Schema.Types.Mixed, required: true },
    settingsVersion: { type: Number, required: true },
    status: {
      type: String,
      enum: Object.values(DRAFT_STATUSES),
      default: DRAFT_STATUSES.PENDING_REVIEW,
      required: true,
    },
    createdByUserId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    updatedByUserId: { type: ObjectId, ref: 'User', default: null },
    cancelledByUserId: { type: ObjectId, ref: 'User', default: null },
    dispatch: {
      dispatchedByUserId: { type: ObjectId, ref: 'User', default: null },
      dispatchedAt: { type: Date, default: null },
      attempts: { type: Number, default: 0 },
      invitationId: { type: ObjectId, ref: 'EmployeeInvitation', default: null },
      employeeUserId: { type: ObjectId, ref: 'User', default: null },
      employeeCode: { type: String, default: null },
      offerLetterSha256: { type: String, default: null },
      lastFailureCode: { type: String, default: null },
    },
  },
  { timestamps: true, optimisticConcurrency: true },
);

onboardingDraftSchema.index({ status: 1, createdAt: -1 });
onboardingDraftSchema.index({ 'candidate.personalEmail': 1 });

export default mongoose.model('OnboardingDraft', onboardingDraftSchema);
