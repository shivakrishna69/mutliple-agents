/**
 * The offer letter's HTML (services/offerLetterGenerator.js offerLetterHtml, printed from
 * services/offerLetterTemplate.js): the preview watermark, escaping of everything HR or the
 * candidate typed, the figures of the structure, the formal layout (letterhead with the configured
 * logo, reference number, CTC in words, the company's legal details in every footer, three
 * annexures, both signature blocks), and the date-of-birth password. Rendering to PDF
 * and locking it are covered by tests/integration/onboardingOffers.test.js.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { ONBOARDING_MESSAGES } from '../../constants/messages.js';
import { OFFER_LETTER_LOGO, ONBOARDING_SETTINGS } from '../../constants/validation.js';
import { computeCtcStructure } from '../../services/ctcStructure.js';
import { offerLetterHtml, offerLetterPassword, readLogoDataUri } from '../../services/offerLetterGenerator.js';
import { offerReferenceOf } from '../../services/onboardingService.js';

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

  it('has the offer and three annexures, each starting a page, with the page count in the footer', () => {
    const html = offerLetterHtml(letterWith(), { preview: false });
    assert.deepEqual(sectionsOf(html), ['Offer letter', 'Annexure A', 'Annexure B', 'Annexure C']);
    assert.ok(html.includes(ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS.backgroundVerificationClause));
    assert.ok(html.includes('Declaration and Acceptance'));
    assert.ok(html.includes('"Page " counter(page) " of " counter(pages)'));
    for (const item of ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS.joiningChecklist) assert.ok(html.includes(item));
    assert.ok(html.includes(ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS.confidentialityClause));
  });

  it('escapes the clauses, checklist and shift HR writes, and the footer text in its stylesheet', () => {
    const html = offerLetterHtml(
      letterWith({
        candidate: { name: 'Asha </style><script>x()</script>' },
        company: { ...letterWith().company, registeredAddress: 'Plot 1 </style><b>x</b>' },
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
    assert.ok(html.includes('Plot 1 \\3c \\2f style\\3e '), 'the footer writes symbols as CSS escapes');
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

describe('the formal layout', () => {
  const COMPANY = Object.freeze({
    name: 'Example Co',
    legalName: 'Example Software Private Limited',
    registeredAddress: '4th Floor, Example Towers, Hyderabad 500081',
    cin: 'U72200TG2020PTC123456',
    gstin: '36AABCE1234F1Z5',
    website: 'https://example.com',
    email: 'hr@example.com',
    logoDataUri: 'data:image/png;base64,iVBORw0KGgo=',
    brandColor: '#1f5bff',
  });
  const FOOTER_PATTERN = /@bottom-center \{\s*width: 100%;\s*content: ([^;]+);/;
  const PAGE_COUNT = '"Page " counter(page) " of " counter(pages)';
  const decodeCss = (text) => text.replace(/\\([0-9a-f]+) /g, (_, code) => String.fromCodePoint(parseInt(code, 16)));

  it('prints the letterhead logo, the reference number, the addressee and the CTC in words', () => {
    const html = offerLetterHtml(
      letterWith({
        company: COMPANY,
        reference: 'EX/HR/OL/2026/A1B2C3',
        candidate: { name: 'Asha Rao', personalEmail: 'asha@example.org', gender: 'female' },
      }),
      { preview: false },
    );
    assert.ok(html.includes('src="data:image/png;base64,iVBORw0KGgo="'));
    assert.ok(!html.includes('class="brand-mark"'), 'the logo replaces the brand mark');
    assert.ok(html.includes('Ref. No.: <strong>EX/HR/OL/2026/A1B2C3</strong>'));
    assert.ok(html.includes('Ms. Asha Rao'));
    assert.ok(html.includes('Personal email: asha@example.org'));
    assert.ok(html.includes('(Rupees Twenty-Five Lakh only)'));
    assert.ok(html.includes('Example Software Private Limited'));
  });

  it('falls back to the brand mark, no salutation and no reference number', () => {
    const html = offerLetterHtml(letterWith(), { preview: false });
    assert.ok(html.includes('class="brand-mark"'));
    assert.ok(!html.includes('Ref. No.'));
    assert.ok(!html.includes('Mr. Asha') && !html.includes('Ms. Asha'));
  });

  it('puts the legal name, registered office, CIN, GSTIN, website and email in every page footer', () => {
    const html = offerLetterHtml(letterWith({ company: COMPANY }), { preview: false });
    const footer = FOOTER_PATTERN.exec(html)[1];
    const decoded = decodeCss(footer);
    assert.ok(decoded.includes('Example Software Private Limited'));
    assert.ok(decoded.includes('Reg. Office: 4th Floor, Example Towers, Hyderabad 500081'));
    assert.ok(decoded.includes('CIN: U72200TG2020PTC123456'));
    assert.ok(decoded.includes('GSTIN: 36AABCE1234F1Z5'));
    assert.ok(decoded.includes('https://example.com') && decoded.includes('hr@example.com'));
    assert.equal(footer.split(' "\\A" ').length, 4, 'three footer lines and the page count');
    assert.ok(footer.endsWith(PAGE_COUNT));
    // Without them, only the name.
    const bare = offerLetterHtml(letterWith(), { preview: false });
    assert.equal(FOOTER_PATTERN.exec(bare)[1], `"Example Co" "\\A" ${PAGE_COUNT}`);
  });

  it('signs for the company on the left and leaves the candidate’s block on the right, whole on a page', () => {
    const html = offerLetterHtml(
      letterWith({
        terms: {
          ...ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS,
          signatoryName: 'Example Signatory',
          signatoryTitle: 'Head of HR',
        },
      }),
      { preview: false },
    );
    assert.equal(html.match(/<div class="signatures">/g).length, 2, 'on the offer and on the acceptance');
    const block = html.slice(html.indexOf('<div class="signatures">'));
    assert.ok(block.indexOf('class="signatory"') < block.indexOf('class="candidate"'));
    assert.ok(html.includes('Name: Example Signatory') && html.includes('Designation: Head of HR'));
    assert.ok(html.includes('For Example Co'));
    assert.match(html, /\.signatures \{[^}]*break-inside: avoid/);
    assert.match(html, /table\.ctc, table\.grid \{[^}]*break-inside: avoid/);
  });

  it('numbers the joining documents and groups the salary rows', () => {
    const html = offerLetterHtml(letterWith(), { preview: false });
    const checklist = ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS.joiningChecklist;
    assert.ok(html.includes(`<td class="number">${checklist.length}</td>`));
    for (const group of ['Earnings', 'Employer', 'CTC', 'Deductions']) {
      assert.ok(html.includes(`<span>${group}</span>`), group);
    }
    assert.ok(html.includes('Net salary (estimated take-home)'));
    assert.ok(html.includes(rupees(STRUCTURE.earnings.gross.monthly)));
  });

  it('leaves out the background verification term when there is none, and loads nothing from outside', () => {
    const html = offerLetterHtml(
      letterWith({ terms: { ...ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS, backgroundVerificationClause: null } }),
      { preview: false },
    );
    assert.ok(!html.includes('Background verification'));
    assert.ok(html.includes("default-src 'none'"));
    assert.doesNotMatch(html, /(src|href)="https?:/);
  });
});

describe('offer reference and logo', () => {
  const filePath = (url) => fileURLToPath(url);

  it('builds the reference number from the short code, year and the draft id, and none without a draft', () => {
    const issued = new Date('2026-11-18T05:00:00Z');
    assert.equal(offerReferenceOf('NSK', '64b0000000000000000a1b2c', issued), 'NSK/HR/OL/2026/0A1B2C');
    assert.equal(offerReferenceOf(null, '64b0000000000000000a1b2c', issued), 'HR/OL/2026/0A1B2C');
    assert.equal(offerReferenceOf('NSK', null, issued), null);
  });

  it('embeds the bundled logo, and uses none for a missing, oversized or foreign file', () => {
    const bundled = readLogoDataUri(filePath(new URL('../../assets/brand/company-logo.png', import.meta.url)));
    assert.match(bundled, /^data:image\/png;base64,iVBORw0KGgo/);
    assert.equal(readLogoDataUri(filePath(new URL('./no-such-logo.png', import.meta.url))), null);
    assert.equal(readLogoDataUri(filePath(import.meta.url)), null, 'not an image type');
    const oversized = path.join(mkdtempSync(path.join(tmpdir(), 'nsk-logo-')), 'big.png');
    writeFileSync(oversized, Buffer.alloc(OFFER_LETTER_LOGO.MAX_BYTES + 1));
    assert.equal(readLogoDataUri(oversized), null, 'too big');
    assert.equal(readLogoDataUri(null), null);
  });
});

describe('offerLetterPassword', () => {
  it('writes the date of birth as DDMMYYYY', () => {
    assert.equal(offerLetterPassword(new Date('1995-06-15T00:00:00Z')), '15061995');
    assert.equal(offerLetterPassword(new Date('2001-01-02T00:00:00Z')), '02012001');
  });
});
