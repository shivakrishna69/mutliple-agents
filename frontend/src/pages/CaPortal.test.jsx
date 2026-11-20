/**
 * The Form 16 / CA Portal (CaPortal.jsx) shows what the backend sends for the chosen financial year:
 * the KPI counts, eligible employees only with their Form 16 status, and the computation and upload
 * dialog for one of them (CTC split, year-to-date TDS, upload with the computation summary, history).
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestCaEmployee, requestCaEmployees, requestForm16Upload, requestForm16Years } from '../api/taxApi.js';
import CaPortal from './CaPortal.jsx';

vi.mock('../api/taxApi.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requestForm16Years: vi.fn(),
  requestCaEmployees: vi.fn(),
  requestCaEmployee: vi.fn(),
  requestForm16Upload: vi.fn(),
  requestForm16Download: vi.fn(),
}));
vi.mock('../auth/AuthContext.jsx', () => {
  const session = {
    currentUser: { id: 'ca', capabilities: ['manage_form16'] },
    csrfToken: 'csrf',
    markSessionEnded: () => {},
  };
  return { useAuth: () => session };
});

const ARJUN = {
  employeeId: 'emp-arjun',
  employeeCode: 'NSK0003',
  name: 'Arjun Above',
  email: 'arjun@example.com',
  designation: 'Analyst',
  departmentName: 'Engineering',
  annualCtc: 1_200_001,
  form16Status: 'pending',
  documents: [],
};
const HEMA = {
  ...ARJUN,
  employeeId: 'emp-hema',
  name: 'Hema High',
  annualCtc: 2_400_000,
  form16Status: 'uploaded',
  documents: [{ id: 'doc-1', version: 2, partType: 'CONSOLIDATED' }],
};
const listFor = (financialYear) => ({
  financialYear,
  assessmentYear: financialYear === '2026-27' ? '2027-28' : '2026-27',
  summary: { eligible: 2, uploaded: 1, pending: 1 },
  employees: [ARJUN, HEMA],
  matchingCount: 2,
  truncated: false,
});
const DETAIL = {
  financialYear: '2026-27',
  assessmentYear: '2027-28',
  employee: ARJUN,
  ctc: {
    annualCtc: 1_200_001,
    effectiveFrom: null,
    source: 'offer',
    split: {
      taxRegime: 'new',
      basic: 600_000,
      hra: 240_000,
      specialAllowance: 288_001,
      gross: 1_128_001,
      employerProvidentFund: 72_000,
      employerEsi: 0,
      gratuity: 0,
      variablePay: 0,
    },
  },
  taxDeducted: {
    months: [{ period: '2026-04', grossEarnings: 94_000, tds: 6_250 }],
    totals: { grossEarnings: 94_000, tds: 6_250 },
  },
  history: [],
};

describe('CA portal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestForm16Years.mockResolvedValue({ financialYears: ['2026-27', '2025-26'] });
    requestCaEmployees.mockImplementation(async ({ financialYear }) => listFor(financialYear));
    requestCaEmployee.mockResolvedValue(DETAIL);
  });

  it('shows the year’s counts and the eligible employees with their Form 16 status', async () => {
    render(<CaPortal />);
    const rows = await screen.findAllByTestId('ca-employee-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Arjun Above')).toBeTruthy();
    expect(within(rows[0]).getByText('Pending')).toBeTruthy();
    expect(within(rows[1]).getByText('Uploaded')).toBeTruthy();
    expect(within(rows[1]).getByText('v2 · Part A + Part B')).toBeTruthy();
    expect(screen.getByText('Eligible > ₹12L')).toBeTruthy();
    expect(screen.getByText('FY 2026-27 · AY 2027-28')).toBeTruthy();
    expect(requestCaEmployees).toHaveBeenCalledWith(
      { financialYear: '2026-27', search: '', status: '' },
      expect.anything(),
    );
  });

  it('asks again for another year and status', async () => {
    render(<CaPortal />);
    await screen.findAllByTestId('ca-employee-row');
    fireEvent.change(screen.getByTestId('form16-year'), { target: { value: '2025-26' } });
    fireEvent.change(screen.getByLabelText('Form 16 status'), { target: { value: 'pending' } });
    await waitFor(() =>
      expect(requestCaEmployees).toHaveBeenLastCalledWith(
        { financialYear: '2025-26', search: '', status: 'pending' },
        expect.anything(),
      ),
    );
  });

  it('opens the computation dialog and uploads a PDF with the summary', async () => {
    requestForm16Upload.mockResolvedValue({ document: { id: 'doc-9', version: 1 }, supersededId: null });
    render(<CaPortal />);
    const [arjunRow] = await screen.findAllByTestId('ca-employee-row');
    fireEvent.click(within(arjunRow).getByRole('button', { name: 'Upload' }));

    const dialog = await screen.findByTestId('form16-upload-dialog');
    expect(await within(dialog).findByTestId('form16-annual-ctc')).toBeTruthy();
    expect(within(dialog).getByText('Basic')).toBeTruthy();
    expect(within(dialog).getByText('Year to date TDS')).toBeTruthy();
    expect(within(dialog).getByText('Nothing uploaded for this year yet.')).toBeTruthy();
    const submit = within(dialog).getByRole('button', { name: 'Upload Form 16' });
    expect(submit.disabled).toBe(true);

    const file = new File(['%PDF-1.7'], 'form16.pdf', { type: 'application/pdf' });
    fireEvent.change(within(dialog).getByLabelText('Form 16 PDF'), { target: { files: [file] } });
    fireEvent.change(within(dialog).getByLabelText('TDS deducted'), { target: { value: '75000' } });
    fireEvent.change(within(dialog).getByLabelText('Tax regime'), { target: { value: 'new' } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(requestForm16Upload).toHaveBeenCalledWith(
        {
          employeeId: 'emp-arjun',
          financialYear: '2026-27',
          partType: 'CONSOLIDATED',
          computationSummary: { tdsDeducted: 75000, taxRegime: 'new' },
          file,
        },
        'csrf',
      ),
    );
    expect(await within(dialog).findByText('Version 1 uploaded')).toBeTruthy();
  });
});
