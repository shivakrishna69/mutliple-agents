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
const STRUCTURE = computeCtcStructure(
  {
    annualCtc: 25_00_000,
    taxRegime: 'new',
    workCity: 'Bengaluru',
    professionalTaxState: 'KA',
    gender: null,
    dateOfBirth: new Date('1995-06-15T00:00:00Z'),
    joiningDate: JOINING_DATE,
  },
  ONBOARDING_SETTINGS.DEFAULT_COMPENSATION_POLICY,
);
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

describe('offerLetterPassword', () => {
  it('writes the date of birth as DDMMYYYY', () => {
    assert.equal(offerLetterPassword(new Date('1995-06-15T00:00:00Z')), '15061995');
    assert.equal(offerLetterPassword(new Date('2001-01-02T00:00:00Z')), '02012001');
  });
});
