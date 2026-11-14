/**
 * The Offers panel (OffersPanel.jsx) and the offer form (OfferFormDialog.jsx) over mocked offer
 * calls: drafts with their status and lifecycle, sending a selection with each outcome shown, a CSV's
 * problems by line and column, the letter preview, and the form's figures, field errors and save.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/httpClient.js';
import {
  requestOfferBulkSend,
  requestOfferCalculation,
  requestOfferDraftCreation,
  requestOfferDrafts,
  requestOfferImport,
  requestOfferSettings,
} from '../../api/offersApi.js';
import OffersPanel from './OffersPanel.jsx';

vi.mock('../../api/offersApi.js', () => ({
  requestOfferBulkSend: vi.fn(),
  requestOfferCalculation: vi.fn(),
  requestOfferDispatch: vi.fn(),
  requestOfferDraftCancel: vi.fn(),
  requestOfferDraftCreation: vi.fn(),
  requestOfferDrafts: vi.fn(),
  requestOfferImport: vi.fn(),
  requestOfferSettings: vi.fn(),
}));
vi.mock('../../auth/AuthContext.jsx', () => {
  const session = { csrfToken: 'csrf', markSessionEnded: () => {} };
  return { useAuth: () => session };
});

const OPTIONS = {
  roles: ['employee'],
  roleOptions: [{ value: 'employee', label: 'Employee', group: 'General' }],
  departments: [{ id: 'd1', name: 'Engineering' }],
  managers: [],
  workLocationTypes: ['Onsite', 'Hybrid'],
  employmentStatuses: ['Probation', 'Active'],
};
const SETTINGS = {
  settings: { offerTerms: { probationMonths: 6, noticePeriodDays: 60, offerValidityDays: 7 } },
  choices: {
    professionalTaxStates: [{ value: 'KA', label: 'Karnataka' }],
    taxRegimes: [{ value: 'new', label: 'New regime' }],
    genders: [{ value: 'female', label: 'Female' }],
    limits: { variablePayMaxBasisPoints: 4000, probationMonthsMax: 12, noticePeriodDaysMax: 180, bulkSendMax: 25 },
  },
};
const draft = (id, name, status, lifecycle = 'INVITED') => ({
  id,
  status,
  lifecycle,
  version: 0,
  candidate: { name, personalEmail: `${id}@example.com`, dateOfBirth: '1995-06-15', gender: null, companyEmail: null },
  position: {
    role: 'employee',
    designation: 'Engineer',
    departmentId: 'd1',
    reportingManagerId: null,
    workLocationType: 'Onsite',
    dateOfJoining: '2026-12-15',
    employmentStatus: 'Probation',
    jobLevel: 'ic',
    employmentType: 'full_time',
  },
  compensation: {
    annualCtc: 12_00_000,
    taxRegime: 'new',
    workCity: 'Bengaluru',
    professionalTaxState: 'KA',
    variablePayAnnual: 0,
    esopUnits: 0,
    components: { basicAnnual: null, hraAnnual: null, specialAllowanceAnnual: null },
  },
  terms: { probationMonths: 6, noticePeriodDays: 60, offerValidUntil: null },
});
const DRAFTS = [
  draft('a1', 'Asha Rao', 'PENDING_REVIEW'),
  draft('b2', 'Bilal Khan', 'DISPATCH_FAILED'),
  draft('c3', 'Chitra Iyer', 'DISPATCHED', 'ACCEPTED'),
];
const split = (annual) => ({ annual, monthly: Math.floor(annual / 12), annualRemainder: annual % 12 });
const STRUCTURE = {
  annualCtc: 12_00_000,
  taxRegime: 'new',
  fixedCtc: split(12_00_000),
  variablePay: split(0),
  splitSetBy: { basic: 'hr', hra: 'policy' },
  earnings: {
    basic: split(6_00_000),
    hra: split(3_00_000),
    specialAllowance: split(2_64_000),
    gross: split(11_64_000),
  },
  employerContributions: { providentFund: split(36_000), esi: split(0), gratuity: split(0), total: split(36_000) },
  employeeDeductions: {
    providentFund: split(36_000),
    esi: split(0),
    professionalTax: split(2_500),
    incomeTax: split(40_000),
    total: split(78_500),
  },
  takeHome: split(10_85_500),
};
const row = (name) => screen.getByRole('row', { name });
const PDF_BYTES = '%PDF-1';

describe('offers panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestOfferSettings.mockResolvedValue(SETTINGS);
    requestOfferDrafts.mockResolvedValue({ drafts: DRAFTS });
  });

  it('lists drafts with their status, and only drafts that can go have a checkbox', async () => {
    render(<OffersPanel options={OPTIONS} />);
    expect(within(await screen.findByRole('row', { name: 'Asha Rao' })).getByText('Waiting for review')).toBeTruthy();
    expect(within(row('Bilal Khan')).getByText('Email failed')).toBeTruthy();
    expect(within(row('Chitra Iyer')).getByText('Accepted')).toBeTruthy();
    expect(within(row('Chitra Iyer')).queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send selected' }).disabled).toBe(true);
  });

  it('sends the selected drafts and shows each outcome with its reason', async () => {
    requestOfferBulkSend.mockResolvedValue({
      notice: '1 sent, 0 created but not emailed, 1 not sent',
      results: [
        { draftId: 'a1', outcome: 'sent', code: null, message: null },
        {
          draftId: 'b2',
          outcome: 'refused',
          code: 'SIGNATORY_MISSING',
          message: 'Set the offer letter signatory first',
        },
      ],
      counts: { sent: 1, email_failed: 0, refused: 1 },
    });
    render(<OffersPanel options={OPTIONS} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Asha Rao' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bilal Khan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send selected' }));
    const results = await screen.findByRole('list', { name: 'Send results' });
    expect(requestOfferBulkSend).toHaveBeenCalledWith(['a1', 'b2'], 'csrf');
    expect(
      within(results)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['SentAsha Rao', 'Not sentBilal KhanSet the offer letter signatory first']);
    expect(screen.getByText('1 sent, 0 created but not emailed, 1 not sent')).toBeTruthy();
  });

  it("lists a CSV's problems by line and column", async () => {
    requestOfferImport.mockImplementation(async () => {
      throw new ApiError({
        message: 'Some rows need fixing. No offers were created',
        status: 400,
        details: [
          { line: 3, field: 'special_allowance', message: 'The components do not add up to the fixed CTC' },
          { line: 4, field: 'department_code', message: 'no active department has this code' },
        ],
      });
    });
    render(<OffersPanel options={OPTIONS} />);
    fireEvent.change(await screen.findByLabelText('Offer CSV file'), {
      target: { files: [new File(['name'], 'offers.csv', { type: 'text/csv' })] },
    });
    const table = await screen.findByRole('table', { name: 'Rows to fix' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((tableRow) => tableRow.textContent),
    ).toEqual([
      'LineColumnProblem',
      '3special_allowanceThe components do not add up to the fixed CTC',
      '4department_codeno active department has this code',
    ]);
  });

  it("previews a draft's letter", async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:letter');
    globalThis.URL.revokeObjectURL = vi.fn();
    requestOfferCalculation.mockResolvedValue({
      structure: STRUCTURE,
      preview: { mediaType: 'application/pdf', base64: btoa(PDF_BYTES) },
    });
    render(<OffersPanel options={OPTIONS} />);
    fireEvent.click(
      within(await screen.findByRole('row', { name: 'Asha Rao' })).getByRole('button', { name: 'Preview' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Offer letter preview: Asha Rao' });
    expect(within(dialog).getByTitle('Offer letter').getAttribute('src')).toBe('blob:letter');
    expect(requestOfferCalculation).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a1@example.com', annualCtc: 12_00_000, includePreview: true }),
      'csrf',
    );
  });
});

describe('offer form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestOfferSettings.mockResolvedValue(SETTINGS);
    requestOfferDrafts.mockResolvedValue({ drafts: [] });
  });

  async function openForm() {
    render(<OffersPanel options={OPTIONS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New offer' }));
    return screen.getByRole('dialog', { name: 'New offer' });
  }

  it("works out the figures, marking a component HR set, and shows the backend's field errors", async () => {
    requestOfferCalculation.mockResolvedValueOnce({ structure: STRUCTURE, preview: null });
    const dialog = await openForm();
    fireEvent.change(within(dialog).getByLabelText('Annual CTC (₹)'), { target: { value: '12,00,000' } });
    fireEvent.change(within(dialog).getByLabelText('Basic a year (₹)'), { target: { value: '6,00,000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Work out figures' }));
    const table = await within(dialog).findByRole('table', { name: 'Salary structure' });
    expect(within(table).getByText('(set by HR)')).toBeTruthy();
    expect(requestOfferCalculation).toHaveBeenCalledWith(
      expect.objectContaining({ annualCtc: 12_00_000, components: expect.objectContaining({ basicAnnual: 6_00_000 }) }),
      'csrf',
    );

    requestOfferCalculation.mockImplementationOnce(async () => {
      throw new ApiError({
        message: 'Some details need fixing',
        status: 400,
        fieldErrors: { 'components.basicAnnual': 'must be whole rupees a year, within the CTC' },
      });
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Work out figures' }));
    expect(await within(dialog).findByText('must be whole rupees a year, within the CTC')).toBeTruthy();
  });

  it('saves the offer for review', async () => {
    requestOfferDraftCreation.mockResolvedValue({ draft: DRAFTS[0], notice: 'Offer draft saved for review' });
    const dialog = await openForm();
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Save for review' }).closest('form'));
    expect(await screen.findByText('Offer draft saved for review')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'New offer' })).toBeNull();
  });
});
