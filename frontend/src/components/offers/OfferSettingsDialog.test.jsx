/**
 * Offer settings (OfferSettingsDialog.jsx): the signatory, terms, clauses and salary split policy, the
 * policy editable only with manage_compensation and the terms only with manage_offers, only changes
 * sent with the version, and the backend's field errors shown on their fields.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestOfferSettingsUpdate } from '../../api/offersApi.js';
import { ApiError } from '../../api/httpClient.js';
import OfferSettingsDialog from './OfferSettingsDialog.jsx';

vi.mock('../../api/offersApi.js', () => ({ requestOfferSettingsUpdate: vi.fn() }));
const session = { csrfToken: 'csrf', currentUser: null };
vi.mock('../../auth/AuthContext.jsx', () => ({ useAuth: () => session }));

const SETTINGS = {
  version: 2,
  offerTerms: {
    probationMonths: 6,
    noticePeriodDays: 60,
    weeklyWorkingHours: 40,
    offerValidityDays: 7,
    signatoryName: null,
    signatoryTitle: null,
    additionalClauses: [],
    shiftTimings: null,
    confidentialityClause: 'Keep it confidential.',
    ipAssignmentClause: 'Work belongs to the company.',
    nonSolicitationClause: 'Do not poach.',
    nonSolicitationMonths: 12,
    backgroundVerificationClause: 'We may verify.',
    esopNote: null,
    joiningChecklist: ['PAN card'],
  },
  compensation: {
    basicShareBasisPoints: 5000,
    hraFiftyPercentCityBasisPoints: 5000,
    hraOtherCityBasisPoints: 4000,
    pfOnFullBasic: false,
    includeGratuityInCtc: false,
  },
};
const CHOICES = {
  limits: {
    probationMonthsMax: 12,
    noticePeriodDaysMax: 180,
    offerValidityDaysMax: 60,
    weeklyWorkingHoursMax: 48,
    nonSolicitationMonthsMax: 24,
    signatoryMaxLength: 100,
    shiftTimingsMaxLength: 120,
    legalClauseMaxLength: 2000,
    esopNoteMaxLength: 600,
    clausesMax: 10,
    clauseMaxLength: 600,
    checklistItemsMax: 15,
    checklistItemMaxLength: 200,
    basicShareMinBasisPoints: 3000,
    basicShareMaxBasisPoints: 7000,
    hraMaxBasisPoints: 5000,
  },
};
const HR = { capabilities: ['read_offers', 'manage_offers', 'manage_compensation'] };
const FINANCE = { capabilities: ['read_offers', 'manage_compensation'] };
const READER = { capabilities: ['read_offers'] };

function renderDialog(props = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<OfferSettingsDialog settings={SETTINGS} choices={CHOICES} onSaved={onSaved} onClose={onClose} {...props} />);
  return { onSaved, onClose };
}
const field = (label) => screen.getByLabelText(label);

describe('offer settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.currentUser = HR;
  });

  it('opens at the signatory, and saves only what changed with the version', async () => {
    requestOfferSettingsUpdate.mockResolvedValue({ settings: SETTINGS, notice: 'Onboarding settings updated' });
    const { onSaved } = renderDialog({ focusField: 'signatoryName' });
    await waitFor(() => expect(document.activeElement).toBe(field('Signatory name')));
    fireEvent.change(field('Signatory name'), { target: { value: 'Example Signatory' } });
    fireEvent.change(field('Signatory designation'), { target: { value: 'Manager - HR' } });
    fireEvent.change(field('Basic (% of CTC)'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(SETTINGS, 'Onboarding settings updated'));
    expect(requestOfferSettingsUpdate).toHaveBeenCalledWith(
      {
        version: 2,
        offerTerms: { signatoryName: 'Example Signatory', signatoryTitle: 'Manager - HR' },
        compensation: { basicShareBasisPoints: 4000 },
      },
      'csrf',
    );
  });

  it('closes without a request when nothing changed', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onClose).toHaveBeenCalled();
    expect(requestOfferSettingsUpdate).not.toHaveBeenCalled();
  });

  it('lets finance change the policy but not the terms', async () => {
    session.currentUser = FINANCE;
    requestOfferSettingsUpdate.mockResolvedValue({ settings: SETTINGS, notice: 'saved' });
    renderDialog();
    expect(field('Signatory name').disabled).toBe(true);
    expect(field('Confidentiality').disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Gratuity inside the CTC/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(requestOfferSettingsUpdate).toHaveBeenCalledWith(
        { version: 2, compensation: { includeGratuityInCtc: true } },
        'csrf',
      ),
    );
  });

  it('shows the policy read-only, and no save, to someone who may only read offers', () => {
    session.currentUser = READER;
    renderDialog();
    expect(screen.queryByLabelText('Basic (% of CTC)')).toBeNull();
    expect(screen.getAllByText('50%')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);
  });

  it('shows the backend’s message and field errors', async () => {
    requestOfferSettingsUpdate.mockRejectedValue(
      new ApiError({
        status: 400,
        message: 'Some details need fixing',
        fieldErrors: { 'offerTerms.noticePeriodDays': 'Notice period must be 0 to 180 days' },
      }),
    );
    renderDialog();
    fireEvent.change(field('Notice period (days)'), { target: { value: '170' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Some details need fixing')).toBeTruthy();
    expect(screen.getByText('Notice period must be 0 to 180 days')).toBeTruthy();
  });
});
