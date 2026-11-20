/**
 * Employees hired through an offer before EmployeeProfile.compensation existed get the CTC of the
 * offer they were sent (the latest sent offer, when there were several). Only profiles without a CTC
 * are touched, so a figure HR has set since is never overwritten, and a second run changes nothing.
 */

import EmployeeProfile from '../models/EmployeeProfile.js';
import OnboardingDraft, { DRAFT_STATUSES } from '../models/OnboardingDraft.js';
import { offerCompensationOf } from '../services/employeeCompensation.js';

// Both mean the employee was created; DISPATCH_FAILED only means the email did not go.
const SENT_STATUSES = Object.freeze([DRAFT_STATUSES.DISPATCHED, DRAFT_STATUSES.DISPATCH_FAILED]);

export default Object.freeze({
  name: 'add-employee-compensation',
  async run() {
    const sentOffers = await OnboardingDraft.find({
      status: { $in: SENT_STATUSES },
      'dispatch.employeeUserId': { $ne: null },
    })
      .select(
        'compensation.annualCtc position.dateOfJoining dispatch.employeeUserId dispatch.dispatchedByUserId updatedAt',
      )
      .sort({ updatedAt: 1 })
      .lean();
    // The latest offer per person wins (sorted oldest first, so later ones overwrite).
    const offerByUserId = new Map(sentOffers.map((offer) => [offer.dispatch.employeeUserId.toString(), offer]));
    if (offerByUserId.size === 0) return { changedCount: 0 };

    const operations = [...offerByUserId.values()].map((offer) => {
      const { annualCtc, effectiveFrom, source } = offerCompensationOf(offer);
      return {
        updateOne: {
          filter: { userId: offer.dispatch.employeeUserId, 'compensation.annualCtc': null },
          update: {
            $set: {
              'compensation.annualCtc': annualCtc,
              'compensation.effectiveFrom': effectiveFrom,
              'compensation.source': source,
              'compensation.updatedByUserId': offer.dispatch.dispatchedByUserId ?? null,
            },
          },
        },
      };
    });
    const result = await EmployeeProfile.bulkWrite(operations, { ordered: false });
    return { changedCount: result.modifiedCount };
  },
});
