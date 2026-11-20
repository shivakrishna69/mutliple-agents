/**
 * An employee's current annual CTC (EmployeeProfile.compensation): salary data, read and changed only
 * through here (MANAGE_COMPENSATION: administrators, HR, Finance & Payroll) and by the Form 16 portal.
 *
 *   recordOfferCompensation   when an offer is sent, the person it creates gets the offer's CTC
 *                             (services/onboardingService.js dispatchDraft)
 *   listEmployeeCompensation  the current employees' CTC, for the Workplace employee list
 *   setEmployeeCompensation   HR, finance or an administrator sets it (people hired before offers
 *                             existed, a raise)
 *
 * Figures are never logged; callers audit ids and outcomes only.
 */

import EmployeeProfile, { COMPENSATION_SOURCES, EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import { employeeNotFound } from './serviceError.js';

const COMPENSATION_FIELDS =
  '+compensation.annualCtc +compensation.effectiveFrom +compensation.source +compensation.updatedByUserId';

const toIdString = (id) => (id ? id.toString() : null);

/** The compensation part of a profile loaded with COMPENSATION_FIELDS, as the API shows it. */
export function compensationOf(profile) {
  const compensation = profile.compensation ?? {};
  return {
    employeeId: profile._id.toString(),
    annualCtc: compensation.annualCtc ?? null,
    effectiveFrom: compensation.effectiveFrom ?? null,
    source: compensation.source ?? null,
  };
}

/**
 * The CTC an offer gives the person it creates: the offer's annual CTC, from the joining date.
 * @param {{ compensation: { annualCtc: number }, position: { dateOfJoining: Date } }} offer
 */
export function offerCompensationOf(offer) {
  return {
    annualCtc: offer.compensation.annualCtc,
    effectiveFrom: offer.position.dateOfJoining ?? null,
    source: COMPENSATION_SOURCES.OFFER,
  };
}

/**
 * Sets the CTC of the employee whose account `employeeUserId` is, from the offer they were sent.
 * @returns {Promise<boolean>} whether an employee record was found
 */
export async function recordOfferCompensation({ employeeUserId, offer, actorUserId }) {
  const { annualCtc, effectiveFrom, source } = offerCompensationOf(offer);
  const result = await EmployeeProfile.updateOne(
    { userId: employeeUserId },
    {
      $set: {
        'compensation.annualCtc': annualCtc,
        'compensation.effectiveFrom': effectiveFrom,
        'compensation.source': source,
        'compensation.updatedByUserId': actorUserId ?? null,
      },
    },
    { runValidators: true },
  );
  return result.matchedCount > 0;
}

/** Current employees' CTC: [{ employeeId, annualCtc, effectiveFrom, source }]. */
export async function listEmployeeCompensation() {
  const profiles = await EmployeeProfile.find({
    'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
  })
    .select(COMPENSATION_FIELDS)
    .lean();
  return profiles.map(compensationOf);
}

/**
 * Sets an employee's CTC (validated by the model: whole rupees within EMPLOYEE_COMPENSATION_LIMITS).
 * @param {{ employeeId: string, annualCtc: number, effectiveFrom: Date|null, actorUserId: string }} change
 */
export async function setEmployeeCompensation({ employeeId, annualCtc, effectiveFrom, actorUserId }) {
  const profile = await EmployeeProfile.findById(employeeId).select(COMPENSATION_FIELDS);
  if (!profile) throw employeeNotFound();
  profile.set('compensation.annualCtc', annualCtc);
  profile.set('compensation.effectiveFrom', effectiveFrom);
  profile.set('compensation.source', COMPENSATION_SOURCES.MANUAL);
  profile.set('compensation.updatedByUserId', toIdString(actorUserId));
  await profile.save();
  return compensationOf(profile);
}
