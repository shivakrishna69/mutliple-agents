/**
 * Operations cards for the daily briefing: counts of work waiting on a team, for the people whose
 * capabilities cover it (exact database counts, each linking to the page that clears it):
 *
 *   support chats      escalated to a person and not yet claimed            STAFF_SUPPORT
 *   corrections        attendance corrections waiting for review: every one  MANAGE_WORKFORCE, or the
 *                      for HR and administrators, a manager's own reports'   person's own reports
 *   offers             drafts waiting to be sent, or whose email failed       MANAGE_OFFERS
 *   Form 16            eligible employees without this year's Form 16         MANAGE_FORM16
 *
 * A count of 0 makes no card.
 */

import { CAPABILITIES, hasCapability } from '../../constants/accessRoles.js';
import { INSIGHT_MESSAGES } from '../../constants/messages.js';
import Conversation, { CONVERSATION_STATUS } from '../../models/Conversation.js';
import OnboardingDraft, { DRAFT_STATUSES } from '../../models/OnboardingDraft.js';
import RegularizationReview, { REVIEW_STATUSES } from '../../models/RegularizationReview.js';
import { getCompanySettings } from '../companySettings.js';
import { offeredFinancialYears } from '../tax/form16Eligibility.js';
import { countForm16Pending } from '../tax/form16Service.js';
import { findOwnEmployeeProfileId, isWorkforceAdmin } from '../workforceAccess.js';
import { INSIGHT_ACTIONS, INSIGHT_KINDS, INSIGHT_SEVERITIES } from './insightFormat.js';

/**
 * The web app's pages these cards open. Must match the frontend's routes
 * (frontend/src/constants/routes.js).
 */
export const OPERATIONS_APP_PATHS = Object.freeze({
  SUPPORT_CONSOLE: '/console',
  ATTENDANCE: '/attendance',
  ONBOARDING: '/people/onboarding',
  CA_PORTAL: '/tax/ca-portal',
});

const OFFERS_WAITING = Object.freeze([DRAFT_STATUSES.PENDING_REVIEW, DRAFT_STATUSES.DISPATCH_FAILED]);

function countCard(kind, title, path, now) {
  return {
    id: kind,
    kind,
    severity: INSIGHT_SEVERITIES.NORMAL,
    label: INSIGHT_MESSAGES.LABELS.OPERATIONS,
    title,
    body: '',
    facts: [],
    actions: [{ kind: INSIGHT_ACTIONS.OPEN_PAGE, label: INSIGHT_MESSAGES.ACTIONS.OPEN, path }],
    at: now.toISOString(),
  };
}

async function correctionsFilterFor(viewer) {
  if (isWorkforceAdmin(viewer.role)) return { status: REVIEW_STATUSES.PENDING };
  const employeeId = await findOwnEmployeeProfileId(viewer.id);
  return employeeId ? { status: REVIEW_STATUSES.PENDING, reportingManagerId: employeeId } : null;
}

/**
 * @param {{ id: string, role: string }} viewer
 * @param {{ now: Date }} options
 */
export async function buildOperationsCards(viewer, { now }) {
  const can = (capability) => hasCapability(viewer.role, capability);
  const correctionsFilter = await correctionsFilterFor(viewer);
  const financialYear = can(CAPABILITIES.MANAGE_FORM16)
    ? offeredFinancialYears((await getCompanySettings()).timeZone, now)[0]
    : null;
  const [supportWaiting, corrections, offers, form16] = await Promise.all([
    can(CAPABILITIES.STAFF_SUPPORT)
      ? Conversation.countDocuments({ status: CONVERSATION_STATUS.ESCALATED_TO_HUMAN, assignedAgentId: null })
      : 0,
    correctionsFilter ? RegularizationReview.countDocuments(correctionsFilter) : 0,
    can(CAPABILITIES.MANAGE_OFFERS) ? OnboardingDraft.countDocuments({ status: { $in: OFFERS_WAITING } }) : 0,
    financialYear ? countForm16Pending(financialYear) : 0,
  ]);
  const cards = [];
  if (supportWaiting > 0) {
    cards.push(
      countCard(
        INSIGHT_KINDS.SUPPORT_WAITING,
        INSIGHT_MESSAGES.supportWaiting(supportWaiting),
        OPERATIONS_APP_PATHS.SUPPORT_CONSOLE,
        now,
      ),
    );
  }
  if (corrections > 0) {
    cards.push(
      countCard(
        INSIGHT_KINDS.CORRECTIONS_PENDING,
        INSIGHT_MESSAGES.correctionsPending(corrections),
        OPERATIONS_APP_PATHS.ATTENDANCE,
        now,
      ),
    );
  }
  if (offers > 0) {
    cards.push(
      countCard(
        INSIGHT_KINDS.OFFERS_PENDING,
        INSIGHT_MESSAGES.offersPending(offers),
        OPERATIONS_APP_PATHS.ONBOARDING,
        now,
      ),
    );
  }
  if (form16 > 0) {
    cards.push(
      countCard(
        INSIGHT_KINDS.FORM16_PENDING,
        INSIGHT_MESSAGES.form16Pending(form16, financialYear),
        OPERATIONS_APP_PATHS.CA_PORTAL,
        now,
      ),
    );
  }
  return cards;
}
