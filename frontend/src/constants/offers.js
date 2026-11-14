/**
 * How offers are shown (backend models/OnboardingDraft.js statuses, services/onboardingService.js
 * lifecycle and bulk send outcomes). Values mirror the backend's; its messages are shown as sent.
 */

export const OFFER_STATUSES = Object.freeze({
  PENDING_REVIEW: 'PENDING_REVIEW',
  DISPATCHING: 'DISPATCHING',
  DISPATCHED: 'DISPATCHED',
  DISPATCH_FAILED: 'DISPATCH_FAILED',
  CANCELLED: 'CANCELLED',
});

/** Drafts that can be sent (or sent again after a failed email). */
export const SENDABLE_STATUSES = Object.freeze([OFFER_STATUSES.PENDING_REVIEW, OFFER_STATUSES.DISPATCH_FAILED]);

export const OFFER_STATUS_DISPLAY = Object.freeze({
  PENDING_REVIEW: { label: 'Waiting for review', tone: 'amber' },
  DISPATCHING: { label: 'Sending', tone: 'sky' },
  DISPATCHED: { label: 'Sent', tone: 'emerald' },
  DISPATCH_FAILED: { label: 'Email failed', tone: 'rose' },
  CANCELLED: { label: 'Cancelled', tone: 'slate' },
});

export const LIFECYCLE_DISPLAY = Object.freeze({
  INVITED: { label: 'Invited', tone: 'slate' },
  OFFER_SENT: { label: 'Offer sent', tone: 'sky' },
  ACCEPTED: { label: 'Accepted', tone: 'emerald' },
  PROBATION: { label: 'On probation', tone: 'violet' },
  JOINED: { label: 'Joined', tone: 'emerald' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'slate' },
});

export const BULK_OUTCOME_DISPLAY = Object.freeze({
  sent: { label: 'Sent', tone: 'emerald' },
  email_failed: { label: 'Email failed', tone: 'amber' },
  refused: { label: 'Not sent', tone: 'rose' },
});
