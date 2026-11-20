/**
 * Payroll → Form 16 (MyForm16Panel.jsx): the backend's note for someone not eligible, "Pending CA
 * upload" with the backend's notice, and for an uploaded Form 16 the CA's summary and a download.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestForm16Download, requestForm16Years, requestMyForm16 } from '../../api/taxApi.js';
import MyForm16Panel from './MyForm16Panel.jsx';

vi.mock('../../api/taxApi.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requestForm16Years: vi.fn(),
  requestMyForm16: vi.fn(),
  requestForm16Download: vi.fn(),
}));
vi.mock('../../auth/AuthContext.jsx', () => {
  const session = { currentUser: { id: 'me' }, csrfToken: 'csrf', markSessionEnded: () => {} };
  return { useAuth: () => session };
});

const BASE = { financialYear: '2026-27', assessmentYear: '2027-28' };
const DOCUMENT = {
  id: 'doc-2',
  partType: 'CONSOLIDATED',
  version: 2,
  uploadedAt: '2026-11-18T10:00:00.000Z',
  computationSummary: {
    grossSalary: 1_850_000,
    totalDeductions: null,
    taxableIncome: 1_775_000,
    totalTaxPayable: 210_000,
    tdsDeducted: 210_000,
    taxRegime: 'new',
    caRemarks: 'Checked against Form 26AS',
  },
};

describe('my Form 16', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestForm16Years.mockResolvedValue({ financialYears: ['2026-27', '2025-26'] });
  });

  it('shows the backend’s note when Form 16 does not apply', async () => {
    requestMyForm16.mockResolvedValue({
      ...BASE,
      eligible: false,
      documents: [],
      notice: 'Form 16 through this portal is issued to employees whose annual CTC is above ₹12,00,000',
    });
    render(<MyForm16Panel />);
    expect(await screen.findByText(/annual CTC is above ₹12,00,000/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Download Form 16 PDF/ })).toBeNull();
  });

  it('says the CA has not uploaded yet', async () => {
    requestMyForm16.mockResolvedValue({ ...BASE, eligible: true, documents: [], notice: 'Not uploaded yet' });
    render(<MyForm16Panel />);
    expect(await screen.findByText('Pending CA upload')).toBeTruthy();
    expect(screen.getByText('Not uploaded yet')).toBeTruthy();
  });

  it('shows the CA’s summary and downloads the PDF', async () => {
    requestMyForm16.mockResolvedValue({ ...BASE, eligible: true, documents: [DOCUMENT], notice: null });
    requestForm16Download.mockResolvedValue({ download: { downloadUrl: 'https://s3.example/signed', expiresAt: 'x' } });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MyForm16Panel />);
    expect(await screen.findByText('Part A + Part B')).toBeTruthy();
    expect(screen.getByText('TDS deducted')).toBeTruthy();
    expect(screen.queryByText('Total deductions')).toBeNull();
    expect(screen.getByText('New regime')).toBeTruthy();
    expect(screen.getByText('Checked against Form 26AS')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Download Form 16 PDF/ }));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith('https://s3.example/signed', '_blank', 'noopener,noreferrer'),
    );
    expect(requestForm16Download).toHaveBeenCalledWith('doc-2');
    openSpy.mockRestore();
  });

  it('asks for the year chosen', async () => {
    requestMyForm16.mockResolvedValue({ ...BASE, eligible: true, documents: [], notice: 'Not uploaded yet' });
    render(<MyForm16Panel />);
    await screen.findByText('Pending CA upload');
    fireEvent.change(screen.getByLabelText('Financial year'), { target: { value: '2025-26' } });
    await waitFor(() => expect(requestMyForm16).toHaveBeenLastCalledWith('2025-26', expect.anything()));
  });
});
