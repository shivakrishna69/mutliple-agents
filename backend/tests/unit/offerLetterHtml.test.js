/**
 * The offer letter's HTML (services/offerLetterGenerator.js offerLetterHtml, printed from
 * services/offerLetterTemplate.js): the preview watermark, escaping of everything HR or the
 * candidate typed, the figures of the structure, and the date-of-birth password. Rendering to PDF
 * and locking it are covered by tests/integration/onboardingOffers.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ONBOARDING_MESSAGES } from '../../constants/messages.js';
import { ONBOARDING_SETTINGS } from '../../constants/validation.js';
import { computeCtcStructure } from '../../services/ctcStructure.js';
import { offerLetterHtml, offerLetterPassword } from '../../services/offerLetterGenerator.js';

const JOINING_DATE = new Date('2026-12-01T00:00:00Z');
const STRUCTURE_INPUT = Object.freeze({
  annualCtc: 25_00_000,
  taxRegime: 'new',
  workCity: 'Bengaluru',
  professionalTaxState: 'KA',
  gender: null,
  dateOfBirth: new Date('1995-06-15T00:00:00Z'),
  joiningDate: JOINING_DATE,
});
const STRUCTURE = computeCtcStructure(STRUCTURE_INPUT, ONBOARDING_SETTINGS.DEFAULT_COMPENSATION_POLICY);
const letterWith = (overrides = {}) => ({
  company: { name: 'Example Co', legalName: null, registeredAddress: null, brandColor: '#1f5bff' },
  candidate: { name: 'Asha Rao' },
  position: {
    designation: 'Engineer',
    departmentName: 'Engineering',
    managerName: null,
    dateOfJoining: JOINING_DATE,
    workLocationType: 'Onsite',
    employmentStatus: 'Probation',
  },
  structure: STRUCTURE,
  terms: { ...ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS, signatoryName: 'Example Signatory' },
  issuedOn: new Date('2026-11-06T00:00:00Z'),
  validUntil: new Date('2026-11-13T00:00:00Z'),
  ...overrides,
});
const rupees = (amount) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);

describe('offer letter HTML', () => {
  it('watermarks a preview and leaves a final letter unmarked', () => {
    assert.ok(offerLetterHtml(letterWith(), { preview: true }).includes(ONBOARDING_MESSAGES.PREVIEW_WATERMARK));
    assert.ok(!offerLetterHtml(letterWith(), { preview: false }).includes(ONBOARDING_MESSAGES.PREVIEW_WATERMARK));
  });

  it('escapes everything typed by people', () => {
    const html = offerLetterHtml(
      letterWith({
        candidate: { name: '<script>alert(1)</script> Rao' },
        terms: {
          ...ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS,
          signatoryName: 'A "quoted" <b>name</b>',
          additionalClauses: ['<img src=x onerror=alert(1)>'],
        },
      }),
      { preview: false },
    );
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<b>name</b>'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  it('prints the CTC, monthly and annual, and the take-home of the structure', () => {
    const html = offerLetterHtml(letterWith(), { preview: false });
    assert.ok(html.includes(rupees(25_00_000)));
    assert.ok(html.includes(rupees(Math.floor(25_00_000 / 12))));
    assert.ok(html.includes(rupees(STRUCTURE.takeHome.annual)));
    assert.ok(html.includes(rupees(STRUCTURE.takeHome.monthly)));
  });

  it('prints the legal name when one is configured, else the company name', () => {
    const named = offerLetterHtml(
      letterWith({ company: { ...letterWith().company, legalName: 'Example Private Limited' } }),
      { preview: false },
    );
    assert.ok(named.includes('Example Private Limited'));
    assert.ok(offerLetterHtml(letterWith(), { preview: false }).includes('Example Co'));
  });
});

describe('offer letter pages', () => {
  const sectionsOf = (html) =>
    [...html.matchAll(/<section class="page" aria-label="([^"]+)">/g)].map((match) => match[1]);

  it('has five sections, each starting a page, with the page count in the footer', () => {
    const html = offerLetterHtml(letterWith(), { preview: false });
    assert.deepEqual(sectionsOf(html), [
      'Letter of appointment',
      'Annexure A',
      'Terms of employment',
      'Confidentiality, IP and non-solicitation',
      'Joining checklist and acceptance',
    ]);
    assert.ok(html.includes('content: "Page " counter(page) " of " counter(pages)'));
    for (const item of ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS.joiningChecklist) assert.ok(html.includes(item));
    assert.ok(html.includes(ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS.confidentialityClause));
  });

  it('escapes the clauses, checklist and shift HR writes, and the footer text in its stylesheet', () => {
    const html = offerLetterHtml(
      letterWith({
        candidate: { name: 'Asha </style><script>x()</script>' },
        terms: {
          ...ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS,
          ipAssignmentClause: '<script>steal()</script>',
          joiningChecklist: ['<img src=x onerror=y>'],
          shiftTimings: '<b>9</b> to 6',
        },
      }),
      { preview: false },
    );
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<b>9</b>'));
    assert.equal(html.match(/<\/style>/g).length, 1, 'no text closes the stylesheet');
    assert.ok(html.includes('Asha \\3c \\2f style\\3e '), 'the footer writes symbols as CSS escapes');
  });

  it('shows variable pay and stock options only when the offer has them', () => {
    const plain = offerLetterHtml(letterWith(), { preview: false });
    assert.ok(!plain.includes('Performance pay (annual target)'));
    assert.ok(!plain.includes('<h2>Stock options</h2>'));
    const variableStructure = computeCtcStructure(
      { ...STRUCTURE_INPUT, variablePayAnnual: 3_00_000 },
      ONBOARDING_SETTINGS.DEFAULT_COMPENSATION_POLICY,
    );
    const rich = offerLetterHtml(
      letterWith({ structure: variableStructure, stockOptions: { units: 2_500, note: 'Vests over four years.' } }),
      { preview: false },
    );
    assert.ok(rich.includes('Performance pay (annual target)'));
    assert.ok(rich.includes(rupees(3_00_000)));
    assert.ok(rich.includes(rupees(22_00_000)), 'the fixed pay');
    assert.ok(rich.includes('2,500 units'));
    assert.ok(rich.includes('Vests over four years.'));
  });

  it('lists the leave policy, and words zero probation, notice and non-solicitation plainly', () => {
    const withLeave = offerLetterHtml(letterWith({ leavePolicy: [{ name: 'Casual Leave', annualDays: 12 }] }), {
      preview: false,
    });
    assert.ok(withLeave.includes('Casual Leave') && withLeave.includes('12 days a year'));
    const none = offerLetterHtml(
      letterWith({
        terms: {
          ...ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS,
          probationMonths: 0,
          noticePeriodDays: 0,
          nonSolicitationMonths: 0,
        },
      }),
      { preview: false },
    );
    assert.ok(none.includes('the company’s leave policy'));
    assert.ok(none.includes('without a probation period'));
    assert.ok(none.includes('No notice period applies.'));
    assert.ok(none.includes('This applies while you are employed.'));
  });
});

describe('offerLetterPassword', () => {
  it('writes the date of birth as DDMMYYYY', () => {
    assert.equal(offerLetterPassword(new Date('1995-06-15T00:00:00Z')), '15061995');
    assert.equal(offerLetterPassword(new Date('2001-01-02T00:00:00Z')), '02012001');
  });
});
