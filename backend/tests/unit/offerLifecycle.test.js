/**
 * Where a candidate is (services/onboardingService.js offerLifecycleOf), worked out from the draft,
 * its invitation, the joining date and the probation: INVITED → OFFER_SENT → ACCEPTED → PROBATION →
 * JOINED, or WITHDRAWN.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OFFER_LIFECYCLE, offerLifecycleOf } from '../../services/onboardingService.js';

const facts = (overrides) => ({
  status: 'DISPATCHED',
  invitationStatus: 'pending',
  dateOfJoining: '2026-12-01',
  probationMonths: 6,
  today: '2026-11-15',
  ...overrides,
});

describe('offer lifecycle', () => {
  it('is invited until sent, then offer sent until the account is activated', () => {
    for (const status of ['PENDING_REVIEW', 'DISPATCHING', 'DISPATCH_FAILED']) {
      assert.equal(offerLifecycleOf(facts({ status, invitationStatus: null })), OFFER_LIFECYCLE.INVITED, status);
    }
    assert.equal(offerLifecycleOf(facts()), OFFER_LIFECYCLE.OFFER_SENT);
  });

  it('is accepted once activated, on probation from the joining date, joined after it', () => {
    const accepted = facts({ invitationStatus: 'accepted' });
    assert.equal(offerLifecycleOf(accepted), OFFER_LIFECYCLE.ACCEPTED);
    assert.equal(offerLifecycleOf({ ...accepted, today: '2026-12-01' }), OFFER_LIFECYCLE.PROBATION);
    assert.equal(offerLifecycleOf({ ...accepted, today: '2027-05-31' }), OFFER_LIFECYCLE.PROBATION);
    assert.equal(offerLifecycleOf({ ...accepted, today: '2027-06-01' }), OFFER_LIFECYCLE.JOINED);
    assert.equal(
      offerLifecycleOf({ ...accepted, probationMonths: 0, today: '2026-12-01' }),
      OFFER_LIFECYCLE.JOINED,
      'no probation: joined on the first day',
    );
  });

  it('ends probation on the last day of a shorter month', () => {
    const accepted = facts({ invitationStatus: 'accepted', dateOfJoining: '2026-08-31', probationMonths: 6 });
    assert.equal(offerLifecycleOf({ ...accepted, today: '2027-02-27' }), OFFER_LIFECYCLE.PROBATION);
    assert.equal(offerLifecycleOf({ ...accepted, today: '2027-02-28' }), OFFER_LIFECYCLE.JOINED);
  });

  it('is withdrawn when the draft was cancelled or the invitation revoked', () => {
    assert.equal(offerLifecycleOf(facts({ status: 'CANCELLED', invitationStatus: null })), OFFER_LIFECYCLE.WITHDRAWN);
    assert.equal(offerLifecycleOf(facts({ invitationStatus: 'revoked' })), OFFER_LIFECYCLE.WITHDRAWN);
  });
});
