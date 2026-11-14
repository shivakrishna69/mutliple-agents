/**
 * Offers from a CSV, without a database: how a row's cells become the request a single offer takes
 * (services/offerImport.js rowToOfferRequest), how the file's headers are read (OFFER_CSV), and the
 * bulk send request (validators/onboardingValidators.js validateBulkSend).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ONBOARDING_SETTINGS } from '../../constants/validation.js';
import { parseImportCsv } from '../../services/employeeImportParser.js';
import { OFFER_CSV, rowToOfferRequest } from '../../services/offerImport.js';
import { validateBulkSend, validateOfferInput } from '../../validators/onboardingValidators.js';

const DEPARTMENT_ID = '65f1a2b3c4d5e6f708192a11';
const ROW = Object.freeze({
  name: 'Asha Rao',
  personal_email: 'Asha.Rao@Example.com',
  department_code: 'eng',
  designation: 'Data Engineer',
  date_of_joining: '2026-12-15',
  date_of_birth: '1995-06-15',
  ctc: '25,00,000',
  work_city: 'Bengaluru',
  professional_tax_state: 'ka',
});

describe('offer CSV rows', () => {
  it('turns cells into the request a single offer takes, reading amounts and choices loosely', () => {
    const request = rowToOfferRequest(
      {
        ...ROW,
        work_type: 'hybrid',
        employment_status: 'active',
        tax_regime: 'OLD',
        gender: 'Female',
        fixed_base: '₹ 10,00,000',
        variable_pay: '2,50,000',
        esop_units: '1200',
        probation_months: '3',
        notice_period_days: '30',
        offer_valid_until: '2026-11-30',
      },
      { departmentId: DEPARTMENT_ID, reportingManagerId: null },
    );
    assert.equal(request.annualCtc, 25_00_000);
    assert.equal(request.professionalTaxState, 'KA');
    assert.equal(request.workLocationType, 'Hybrid');
    assert.equal(request.employmentStatus, 'Active');
    assert.equal(request.taxRegime, 'old');
    assert.equal(request.gender, 'female');
    assert.deepEqual(request.components, {
      basicAnnual: 10_00_000,
      hraAnnual: undefined,
      specialAllowanceAnnual: undefined,
    });
    assert.equal(request.variablePayAnnual, 2_50_000);
    assert.equal(request.esopUnits, 1_200);
    assert.deepEqual(request.terms, { probationMonths: 3, noticePeriodDays: 30, offerValidUntil: '2026-11-30' });
    const offer = validateOfferInput(request, { now: new Date('2026-11-11T00:00:00Z') });
    assert.equal(offer.isValid, true, JSON.stringify(offer.validationErrors));
    assert.equal(offer.sanitizedInput.candidate.personalEmail, 'asha.rao@example.com');
  });

  it('leaves out what a row does not give, with the employee defaults, and keeps bad text for the validator', () => {
    const request = rowToOfferRequest(ROW, { departmentId: DEPARTMENT_ID });
    assert.equal(request.components, undefined);
    assert.equal(request.terms, undefined);
    assert.equal(request.workLocationType, 'Onsite');
    assert.equal(request.employmentStatus, 'Probation');
    const bad = rowToOfferRequest({ ...ROW, ctc: 'twenty lakh', work_type: 'moon' }, { departmentId: DEPARTMENT_ID });
    assert.equal(bad.annualCtc, 'twenty lakh');
    const fields = validateOfferInput(bad).validationErrors.map((error) => error.field);
    assert.ok(fields.includes('annualCtc') && fields.includes('workLocationType'));
  });

  it('reads the offer columns by their usual names, and refuses a file without the required ones', async () => {
    const file = Buffer.from(
      'Full Name,Email,Department Code,Title,Joining Date,DOB,Annual CTC,City,PT State,Basic,Variable,ESOPs\n' +
        'Asha Rao,asha@example.com,ENG,Engineer,2026-12-15,1995-06-15,2500000,Pune,MH,1000000,250000,100\n',
    );
    const { rows, ignoredColumns } = await parseImportCsv(file, OFFER_CSV);
    assert.deepEqual(ignoredColumns, []);
    assert.equal(rows[0].rowNumber, 2);
    assert.equal(rows[0].values.ctc, '2500000');
    assert.equal(rows[0].values.fixed_base, '1000000');
    assert.equal(rows[0].values.esop_units, '100');
    await assert.rejects(
      parseImportCsv(Buffer.from('name,personal_email\nAsha,asha@example.com\n'), OFFER_CSV),
      (error) => error.code === 'COLUMNS_MISSING' && /date_of_birth/.test(error.message) && /ctc/.test(error.message),
    );
  });
});

describe('bulk send request', () => {
  const ids = (count) =>
    Array.from({ length: count }, (_, index) => `65f1a2b3c4d5e6f7081920${String(index).padStart(2, '0')}`);

  it('takes 1 to BULK_SEND_MAX different draft ids', () => {
    assert.deepEqual(validateBulkSend({ draftIds: ids(2) }).sanitizedInput.draftIds, ids(2));
    for (const body of [
      { draftIds: [] },
      { draftIds: ids(ONBOARDING_SETTINGS.BULK_SEND_MAX + 1) },
      { draftIds: [ids(1)[0], ids(1)[0]] },
      { draftIds: ['not-an-id'] },
      { draftIds: ids(1), sendAt: 'now' },
    ]) {
      assert.equal(validateBulkSend(body).isValid, false, JSON.stringify(body));
    }
  });
});
