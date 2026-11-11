/**
 * Onboarding offers end to end (/api/hr/onboarding): who may use them, input checks, the settings,
 * calculate writing nothing, the draft lifecycle, and the human-triggered dispatch: once only,
 * refused when the figures changed or no signatory is set, the employee and invitation created
 * with a 48-hour link, the letter attached and locked with the candidate's date of birth, and a
 * failed email retried without a second employee.
 *
 * The PDF tests need a Chromium (PDF_BROWSER_CHANNEL or PDF_BROWSER_EXECUTABLE_PATH, as for the
 * server) and qpdf (QPDF_PATH, default "qpdf"); without them those tests are skipped and say why,
 * except in CI (CI=true), where a missing tool fails the run instead of hiding the tests.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ONBOARDING_MESSAGES } from '../../constants/messages.js';
import { ONBOARDING_SETTINGS } from '../../constants/validation.js';
import { isQpdfAvailable } from '../../services/pdfProtection.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { tokenFromEmail } from './mailCatcher.js';
import {
  STRONG_PASSWORD,
  createSignedInClient,
  mongoUnavailableReason,
  startTestServer,
  TEST_ADMIN_EMAIL,
} from './testServer.js';

const runFile = promisify(execFile);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const qpdfPath = process.env.QPDF_PATH || 'qpdf';
const pdfBrowserEnvironment = Object.fromEntries(
  ['PDF_BROWSER_CHANNEL', 'PDF_BROWSER_EXECUTABLE_PATH']
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
);
const pdfEnvironment = { ...pdfBrowserEnvironment, QPDF_PATH: qpdfPath };
const mongoReason = await mongoUnavailableReason();
const pdfReason =
  mongoReason ??
  (Object.keys(pdfBrowserEnvironment).length === 0
    ? 'no PDF browser: set PDF_BROWSER_CHANNEL or PDF_BROWSER_EXECUTABLE_PATH'
    : (await isQpdfAvailable(qpdfPath))
      ? null
      : `qpdf not found at "${qpdfPath}": install qpdf or set QPDF_PATH`);
if (process.env.CI === 'true' && pdfReason && !mongoReason) {
  throw new Error(`The offer letter tests cannot run in CI: ${pdfReason}`);
}

const SERVER_LOG_TAIL_CHARACTERS = 4_000;
/** The response body and the end of the server's log, so a failed letter shows its cause. */
const explain = (testServer, ...responses) =>
  `${JSON.stringify(responses.map((response) => response.body))}
server log:
${testServer.output().slice(-SERVER_LOG_TAIL_CHARACTERS)}`;

/** A joining date 30 days ahead, as YYYY-MM-DD (offers must join within a year). */
const joiningIn = (days) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

function offerBody(departmentId, overrides = {}) {
  return {
    name: 'Asha Rao',
    email: 'asha.rao@example.com',
    designation: 'Senior Engineer',
    departmentId,
    workLocationType: 'Hybrid',
    dateOfJoining: joiningIn(30),
    employmentStatus: 'Probation',
    dateOfBirth: '1995-06-15',
    annualCtc: 25_00_000,
    taxRegime: 'new',
    workCity: 'Bengaluru',
    professionalTaxState: 'KA',
    ...overrides,
  };
}

const fieldsOf = (response) => (response.body.error?.details ?? []).map((detail) => detail.field).sort();

async function setSignatory(client, signatoryName = 'Naren Kumar') {
  const { version } = (await client.get('/api/hr/onboarding/settings')).body.data.settings;
  const response = await client.patch('/api/hr/onboarding/settings', {
    offerTerms: { signatoryName, signatoryTitle: 'Director' },
    version,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.settings;
}

async function createDraft(client, departmentId, overrides) {
  const response = await client.post('/api/hr/onboarding/create-draft', offerBody(departmentId, overrides));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.draft;
}

describe('onboarding offers: who may use them and what they accept', { skip: mongoReason ?? false }, () => {
  let testServer;
  let hrClient;
  let departmentId;

  before(async () => {
    // Denials are logged as warnings, which the audit check below reads.
    testServer = await startTestServer({ mail: false, environment: { LOG_LEVEL: 'warn' } });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema@example.com', role: 'hr' });
    departmentId = await insertDepartment(testServer.database);
  });

  after(async () => {
    await testServer?.stop();
  });

  it('is for HR and administrators only, and audits the refusals', async () => {
    const employee = await createSignedInClient(testServer, { name: 'Esha', email: 'esha@example.com' });
    const agent = await createSignedInClient(testServer, { name: 'Arun', email: 'arun@example.com', role: 'agent' });
    for (const client of [employee, agent]) {
      for (const [method, url, body] of [
        ['get', '/api/hr/onboarding/settings'],
        ['post', '/api/hr/onboarding/calculate', offerBody(departmentId)],
        ['post', '/api/hr/onboarding/create-draft', offerBody(departmentId)],
        ['post', '/api/hr/onboarding/drafts/507f1f77bcf86cd799439011/dispatch', {}],
      ]) {
        const response = await client[method](url, body);
        assert.equal(response.status, 403, `${method} ${url}`);
        assert.equal(response.body.error.message, ONBOARDING_MESSAGES.HR_ONLY);
      }
    }
    assert.match(
      testServer.output(),
      /"action":"dispatch_offer".*"outcome":"denied"|"outcome":"denied".*"action":"dispatch_offer"/,
    );
    assert.equal((await testServer.createClient().get('/api/hr/onboarding/settings')).status, 401);
    const admin = await createSignedInClient(testServer, { name: 'Ada', email: TEST_ADMIN_EMAIL });
    assert.equal((await admin.get('/api/hr/onboarding/settings')).status, 200);
  });

  it('names every field it cannot accept, and refuses operator objects', async () => {
    const empty = await hrClient.post('/api/hr/onboarding/calculate', {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.message, ONBOARDING_MESSAGES.INPUT_INVALID);
    assert.deepEqual(fieldsOf(empty), [
      'annualCtc',
      'dateOfBirth',
      'dateOfJoining',
      'departmentId',
      'designation',
      'email',
      'employmentStatus',
      'name',
      'professionalTaxState',
      'workCity',
      'workLocationType',
    ]);
    const injected = await hrClient.post(
      '/api/hr/onboarding/calculate',
      offerBody(departmentId, { annualCtc: { $gt: 0 }, email: { $ne: null }, dateOfBirth: { $gt: '' } }),
    );
    assert.deepEqual(fieldsOf(injected), ['annualCtc', 'dateOfBirth', 'email']);
    const outOfRange = await hrClient.post(
      '/api/hr/onboarding/calculate',
      offerBody(departmentId, {
        annualCtc: ONBOARDING_SETTINGS.CTC_LIMITS.MAX + 1,
        taxRegime: 'flat',
        professionalTaxState: 'XX',
      }),
    );
    assert.deepEqual(fieldsOf(outOfRange), ['annualCtc', 'professionalTaxState', 'taxRegime']);
    const maharashtra = await hrClient.post(
      '/api/hr/onboarding/calculate',
      offerBody(departmentId, { professionalTaxState: 'MH', workCity: 'Mumbai' }),
    );
    assert.deepEqual(maharashtra.body.error.details, [
      { field: 'gender', message: 'is needed for Maharashtra professional tax' },
    ]);
  });

  it('calculates the pinned 25 LPA structure and writes nothing', async () => {
    await hrClient.get('/api/hr/onboarding/settings'); // creates the settings document first
    const collections = [
      'onboardingdrafts',
      'users',
      'employeeprofiles',
      'employeeinvitations',
      'counters',
      'onboardingsettings',
    ];
    const countAll = () =>
      Promise.all(collections.map((name) => testServer.database.collection(name).countDocuments()));
    const countsBefore = await countAll();
    const response = await hrClient.post('/api/hr/onboarding/calculate', offerBody(departmentId));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { structure, preview } = response.body.data;
    assert.equal(preview, null);
    assert.equal(structure.earnings.gross.annual, 24_64_000);
    assert.equal(structure.employeeDeductions.incomeTax.annual, 3_09_140);
    assert.deepEqual(structure.takeHome, { annual: 21_16_360, monthly: 1_76_363, annualRemainder: 4 });
    assert.deepEqual(await countAll(), countsBefore);
  });

  it('refuses a CTC the policy cannot cover', async () => {
    const { version } = (await hrClient.get('/api/hr/onboarding/settings')).body.data.settings;
    await hrClient.patch('/api/hr/onboarding/settings', {
      compensation: { basicShareBasisPoints: 7_000 },
      version,
    });
    const response = await hrClient.post(
      '/api/hr/onboarding/calculate',
      offerBody(departmentId, { annualCtc: 3_00_000 }),
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'CTC_TOO_LOW');
    assert.equal(response.body.error.message, ONBOARDING_MESSAGES.CTC_TOO_LOW);
  });

  it('keeps the settings within their limits and refuses edits based on an old version', async () => {
    const settings = (await hrClient.get('/api/hr/onboarding/settings')).body.data.settings;
    const invalid = await hrClient.patch('/api/hr/onboarding/settings', {
      compensation: { basicShareBasisPoints: 9_000, pfOnFullBasic: 'yes' },
      version: settings.version,
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(fieldsOf(invalid), ['compensation.pfOnFullBasic']);
    const outOfLimits = await hrClient.patch('/api/hr/onboarding/settings', {
      compensation: { basicShareBasisPoints: 9_000 },
      version: settings.version,
    });
    assert.equal(outOfLimits.status, 400);
    assert.deepEqual(fieldsOf(outOfLimits), ['compensation.basicShareBasisPoints']);
    const saved = await hrClient.patch('/api/hr/onboarding/settings', {
      compensation: { basicShareBasisPoints: 5_000 },
      offerTerms: { noticePeriodDays: 30 },
      version: settings.version,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.settings.offerTerms.noticePeriodDays, 30);
    const stale = await hrClient.patch('/api/hr/onboarding/settings', {
      offerTerms: { noticePeriodDays: 45 },
      version: settings.version,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_VERSION');
  });

  it('takes variable pay, stock options, a split HR sets and the offer’s own terms', async () => {
    const calculated = await hrClient.post('/api/hr/onboarding/calculate', {
      ...offerBody(departmentId),
      variablePayAnnual: 2_50_000,
      components: { basicAnnual: 10_00_000 },
    });
    assert.equal(calculated.status, 200, JSON.stringify(calculated.body));
    const { structure } = calculated.body.data;
    assert.equal(structure.fixedCtc.annual, 22_50_000);
    assert.equal(structure.variablePay.annual, 2_50_000);
    assert.equal(structure.earnings.basic.annual, 10_00_000);
    assert.deepEqual(structure.splitSetBy, { basic: 'hr', hra: 'policy' });

    const { offerTerms } = (await hrClient.get('/api/hr/onboarding/settings')).body.data.settings;
    const draft = await createDraft(hrClient, departmentId, {
      email: 'own.terms@example.com',
      variablePayAnnual: 2_50_000,
      esopUnits: 1_200,
      terms: { probationMonths: 3, offerValidUntil: joiningIn(10) },
    });
    assert.equal(draft.lifecycle, 'INVITED');
    assert.equal(draft.compensation.esopUnits, 1_200);
    assert.deepEqual(draft.terms, {
      probationMonths: 3,
      noticePeriodDays: offerTerms.noticePeriodDays,
      offerValidUntil: joiningIn(10),
    });
    const withDefaults = await createDraft(hrClient, departmentId, { email: 'default.terms@example.com' });
    assert.equal(withDefaults.terms.probationMonths, offerTerms.probationMonths);
    assert.equal(withDefaults.terms.offerValidUntil, null, 'the settings’ validity, counted from the day it is sent');
  });

  it('refuses a split that does not add up, naming the special allowance it would be', async () => {
    const components = { basicAnnual: 10_00_000, hraAnnual: 4_00_000 };
    const fitting = (await hrClient.post('/api/hr/onboarding/calculate', { ...offerBody(departmentId), components }))
      .body.data.structure;
    const special = fitting.earnings.specialAllowance.annual;
    const response = await hrClient.post('/api/hr/onboarding/calculate', {
      ...offerBody(departmentId),
      components: { ...components, specialAllowanceAnnual: special + 500 },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'SPLIT_DOES_NOT_ADD_UP');
    assert.equal(response.body.error.message, ONBOARDING_MESSAGES.SPLIT_DOES_NOT_ADD_UP(special));
    const tooMuch = await hrClient.post('/api/hr/onboarding/calculate', {
      ...offerBody(departmentId),
      components: { basicAnnual: 20_00_000, hraAnnual: 5_00_000 },
    });
    assert.equal(tooMuch.body.error.code, 'SPLIT_EXCEEDS_GROSS');
    const invalid = await hrClient.post('/api/hr/onboarding/calculate', {
      ...offerBody(departmentId),
      variablePayAnnual: 20_00_000,
      esopUnits: -1,
      components: { bonus: 1 },
      terms: { probationMonths: 30, offerValidUntil: '2020-01-01' },
    });
    assert.deepEqual(fieldsOf(invalid), [
      'components.bonus',
      'esopUnits',
      'terms.offerValidUntil',
      'terms.probationMonths',
      'variablePayAnnual',
    ]);
  });

  it('lets HR word the clauses, shift timings and joining checklist, never leaving a clause empty', async () => {
    const before = (await hrClient.get('/api/hr/onboarding/settings')).body.data.settings;
    assert.equal(
      before.offerTerms.confidentialityClause,
      ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS.confidentialityClause,
    );
    assert.deepEqual(before.offerTerms.joiningChecklist, [...ONBOARDING_SETTINGS.DEFAULT_OFFER_TERMS.joiningChecklist]);
    const saved = await hrClient.patch('/api/hr/onboarding/settings', {
      offerTerms: { shiftTimings: '10 am to 7 pm', nonSolicitationMonths: 6, joiningChecklist: ['PAN card'] },
      version: before.version,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.settings.offerTerms.shiftTimings, '10 am to 7 pm');
    assert.deepEqual(saved.body.data.settings.offerTerms.joiningChecklist, ['PAN card']);
    const emptied = await hrClient.patch('/api/hr/onboarding/settings', {
      offerTerms: { ipAssignmentClause: '   ', joiningChecklist: 'PAN card' },
      version: saved.body.data.settings.version,
    });
    assert.equal(emptied.status, 400);
    assert.deepEqual(fieldsOf(emptied), ['offerTerms.joiningChecklist']);
    const blankClause = await hrClient.patch('/api/hr/onboarding/settings', {
      offerTerms: { ipAssignmentClause: '   ' },
      version: saved.body.data.settings.version,
    });
    assert.equal(blankClause.status, 400);
    assert.deepEqual(fieldsOf(blankClause), ['offerTerms.ipAssignmentClause']);
  });

  it('keeps a draft for review, lets it be edited and cancelled, then no longer', async () => {
    const draft = await createDraft(hrClient, departmentId, { email: 'lifecycle@example.com' });
    assert.equal(draft.status, 'PENDING_REVIEW');
    assert.equal(draft.structure.earnings.gross.annual, 24_64_000);
    const listed = (await hrClient.get('/api/hr/onboarding/drafts?status=PENDING_REVIEW')).body.data.drafts;
    assert.ok(listed.some((candidate) => candidate.id === draft.id));
    assert.equal((await hrClient.get('/api/hr/onboarding/drafts?status=SENT')).status, 400);

    const edited = await hrClient.patch(`/api/hr/onboarding/drafts/${draft.id}`, {
      ...offerBody(departmentId, { email: 'lifecycle@example.com', annualCtc: 10_00_000 }),
      version: draft.version,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.draft.structure.takeHome.annual, 9_25_500);
    const stale = await hrClient.patch(`/api/hr/onboarding/drafts/${draft.id}`, {
      ...offerBody(departmentId, { email: 'lifecycle@example.com' }),
      version: draft.version,
    });
    assert.equal(stale.status, 409);

    const cancelled = await hrClient.post(`/api/hr/onboarding/drafts/${draft.id}/cancel`, {
      version: edited.body.data.draft.version,
    });
    assert.equal(cancelled.body.data.draft.status, 'CANCELLED');
    const afterCancel = await hrClient.patch(`/api/hr/onboarding/drafts/${draft.id}`, {
      ...offerBody(departmentId, { email: 'lifecycle@example.com' }),
      version: cancelled.body.data.draft.version,
    });
    assert.equal(afterCancel.status, 409);
    assert.equal(afterCancel.body.error.code, 'DRAFT_NOT_EDITABLE');
    const dispatchCancelled = await hrClient.post(`/api/hr/onboarding/drafts/${draft.id}/dispatch`, {});
    assert.equal(dispatchCancelled.body.error.code, 'DISPATCH_NOT_ALLOWED');
    assert.equal((await hrClient.get('/api/hr/onboarding/drafts/not-an-id')).status, 400);
    assert.equal((await hrClient.get('/api/hr/onboarding/drafts/507f1f77bcf86cd799439011')).status, 404);
  });
});

describe('onboarding offers: dispatch', { skip: pdfReason ?? false }, () => {
  let testServer;
  let hrClient;
  let departmentId;
  let workFolder;

  /** Whether `password` opens the PDF (qpdf --check). */
  async function opens(pdf, password) {
    const pdfPath = path.join(workFolder, `${createHash('sha256').update(pdf).digest('hex')}.pdf`);
    await writeFile(pdfPath, pdf);
    try {
      await runFile(qpdfPath, ['--check', `--password=${password}`, pdfPath]);
      return true;
    } catch {
      return false;
    }
  }

  /** The number of pages of a locked PDF. */
  async function pageCount(pdf, password) {
    const pdfPath = path.join(workFolder, `pages-${createHash('sha256').update(pdf).digest('hex')}.pdf`);
    await writeFile(pdfPath, pdf);
    const { stdout } = await runFile(qpdfPath, ['--show-npages', `--password=${password}`, pdfPath]);
    return Number(stdout.trim());
  }

  before(async () => {
    workFolder = await mkdtemp(path.join(tmpdir(), 'nsk-offer-test-'));
    testServer = await startTestServer({ environment: pdfEnvironment });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema@example.com', role: 'hr' });
    departmentId = await insertDepartment(testServer.database);
  });

  after(async () => {
    await testServer?.stop();
    if (workFolder) await rm(workFolder, { recursive: true, force: true });
  });

  it('previews the letter watermarked and unlocked', async () => {
    const response = await hrClient.post('/api/hr/onboarding/calculate', {
      ...offerBody(departmentId),
      includePreview: true,
    });
    assert.equal(response.status, 200, explain(testServer, response));
    const { mediaType, base64 } = response.body.data.preview;
    assert.equal(mediaType, 'application/pdf');
    const pdf = Buffer.from(base64, 'base64');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal(pdf.includes('/Encrypt'), false);
  });

  it('refuses to send without a signatory, and leaves the draft for review', async () => {
    const draft = await createDraft(hrClient, departmentId, { email: 'no.signatory@example.com' });
    const response = await hrClient.post(`/api/hr/onboarding/drafts/${draft.id}/dispatch`, {});
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'SIGNATORY_MISSING');
    assert.equal(
      (await hrClient.get(`/api/hr/onboarding/drafts/${draft.id}`)).body.data.draft.status,
      'PENDING_REVIEW',
    );
  });

  it('refuses to send figures nobody reviewed, after the policy changed', async () => {
    await setSignatory(hrClient);
    const draft = await createDraft(hrClient, departmentId, { email: 'changed.policy@example.com' });
    const settings = (await hrClient.get('/api/hr/onboarding/settings')).body.data.settings;
    await hrClient.patch('/api/hr/onboarding/settings', {
      compensation: { hraOtherCityBasisPoints: 3_000, hraFiftyPercentCityBasisPoints: 4_500 },
      version: settings.version,
    });
    const response = await hrClient.post(`/api/hr/onboarding/drafts/${draft.id}/dispatch`, {});
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'DRAFT_FIGURES_CHANGED');
    assert.equal(
      (await hrClient.get(`/api/hr/onboarding/drafts/${draft.id}`)).body.data.draft.status,
      'PENDING_REVIEW',
    );
    const { version } = (await hrClient.get('/api/hr/onboarding/settings')).body.data.settings;
    await hrClient.patch('/api/hr/onboarding/settings', {
      compensation: ONBOARDING_SETTINGS.DEFAULT_COMPENSATION_POLICY,
      version,
    });
  });

  it('sends once, creates the employee with a link that works until the offer deadline, and attaches the locked letter', async () => {
    await setSignatory(hrClient);
    const draft = await createDraft(hrClient, departmentId, { email: 'asha.rao@example.com' });
    const codesBefore = await testServer.database
      .collection('employeeprofiles')
      .countDocuments({ employeeCode: { $ne: null } });

    // Two presses at the same moment: one sends, the other is refused.
    const dispatchUrl = `/api/hr/onboarding/drafts/${draft.id}/dispatch`;
    const outcomes = await Promise.all([hrClient.post(dispatchUrl, {}), hrClient.post(dispatchUrl, {})]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [200, 409], explain(testServer, ...outcomes));
    const sent = outcomes.find((outcome) => outcome.status === 200).body;
    assert.equal(sent.message, ONBOARDING_MESSAGES.DISPATCHED);
    assert.equal(sent.data.draft.status, 'DISPATCHED');
    assert.match(sent.data.draft.dispatch.employeeCode, /^NSK\d{4}$/);
    assert.equal(Number(sent.data.draft.dispatch.employeeCode.slice(3)), codesBefore + 1);

    const users = await testServer.database.collection('users').find({ email: 'asha.rao@example.com' }).toArray();
    assert.equal(users.length, 1);
    assert.equal(users[0].status, 'invited');
    const invitations = await testServer.database
      .collection('employeeinvitations')
      .find({ email: 'asha.rao@example.com' })
      .toArray();
    assert.equal(invitations.length, 1);
    // Accepting is activating, so the link works until the end of the offer's deadline day: the
    // settings' validity from today, in the company's time zone (Asia/Kolkata, UTC+05:30).
    const { offerValidityDays } = (await hrClient.get('/api/hr/onboarding/settings')).body.data.settings.offerTerms;
    const todayInCompany = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const deadline = new Date(`${todayInCompany}T00:00:00Z`);
    deadline.setUTCDate(deadline.getUTCDate() + offerValidityDays + 1);
    const endOfDeadlineDay = new Date(`${deadline.toISOString().slice(0, 10)}T00:00:00+05:30`);
    assert.equal(invitations[0].expiresAt.toISOString(), endOfDeadlineDay.toISOString());

    const [email] = await testServer.mailbox.waitForMessages('asha.rao@example.com', 1);
    assert.equal(testServer.mailbox.messagesTo('asha.rao@example.com').length, 1, 'exactly one email');
    assert.match(email.subject, /Your offer from .+: Senior Engineer/);
    assert.match(email.text, /date of birth written DDMMYYYY/);
    assert.doesNotMatch(email.text, /15061995/);
    const [letter] = email.attachments;
    assert.equal(letter.contentType, 'application/pdf');
    assert.equal(letter.filename, 'Offer-letter-Asha-Rao.pdf');
    assert.equal(createHash('sha256').update(letter.content).digest('hex'), sent.data.draft.dispatch.offerLetterSha256);
    assert.equal(await opens(letter.content, '15061995'), true, 'the date of birth opens it');
    assert.equal(await opens(letter.content, '01011990'), false, 'another password does not');
    assert.equal(await pageCount(letter.content, '15061995'), 5, 'the five-page letter');
    assert.equal(sent.data.draft.lifecycle, 'OFFER_SENT');

    const again = await hrClient.post(dispatchUrl, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'DISPATCH_NOT_ALLOWED');
  });

  it('accepts by activating before the link ends, and not after', async () => {
    await setSignatory(hrClient);
    const manager = await onboardEmployee({
      testServer,
      hrClient,
      email: 'manager.mehta@example.com',
      name: 'Manav Mehta',
      departmentId,
    });
    const onTime = await createDraft(hrClient, departmentId, {
      email: 'on.time@example.com',
      reportingManagerId: manager.profileId,
    });
    const late = await createDraft(hrClient, departmentId, { email: 'too.late@example.com' });
    for (const draft of [onTime, late]) {
      const sent = await hrClient.post(`/api/hr/onboarding/drafts/${draft.id}/dispatch`, {});
      assert.equal(sent.status, 200, explain(testServer, sent));
    }
    const invitations = testServer.database.collection('employeeinvitations');
    const tokenOf = async (address) =>
      tokenFromEmail((await testServer.mailbox.waitForMessages(address, 1))[0], '/invite');
    const accept = (token) =>
      testServer.createClient().post(`/api/invitations/${token}/accept`, {
        password: STRONG_PASSWORD,
        confirmPassword: STRONG_PASSWORD,
        acceptTerms: true,
      });
    // An hour before the link ends.
    await invitations.updateOne(
      { email: 'on.time@example.com' },
      { $set: { expiresAt: new Date(Date.now() + HOUR_MS) } },
    );
    assert.equal((await accept(await tokenOf('on.time@example.com'))).status, 201);
    const accepted = (await hrClient.get(`/api/hr/onboarding/drafts/${onTime.id}`)).body.data.draft;
    assert.equal(accepted.lifecycle, 'ACCEPTED', 'activating the account accepts the offer');
    assert.ok(accepted.acceptedAt);
    // From the joining date, the probation months; after them, joined.
    const drafts = testServer.database.collection('onboardingdrafts');
    const { ObjectId } = testServer.database.base.Types;
    await drafts.updateOne(
      { _id: new ObjectId(onTime.id) },
      { $set: { 'position.dateOfJoining': new Date(Date.now() - 30 * DAY_MS) } },
    );
    assert.equal((await hrClient.get(`/api/hr/onboarding/drafts/${onTime.id}`)).body.data.draft.lifecycle, 'PROBATION');
    await drafts.updateOne(
      { _id: new ObjectId(onTime.id) },
      { $set: { 'position.dateOfJoining': new Date(Date.now() - 400 * DAY_MS) } },
    );
    assert.equal((await hrClient.get(`/api/hr/onboarding/drafts/${onTime.id}`)).body.data.draft.lifecycle, 'JOINED');
    // An hour after it ended.
    await invitations.updateOne(
      { email: 'too.late@example.com' },
      { $set: { expiresAt: new Date(Date.now() - HOUR_MS) } },
    );
    const refused = await accept(await tokenOf('too.late@example.com'));
    assert.notEqual(refused.status, 201);
    assert.match(JSON.stringify(refused.body), /expired/i);
    assert.equal((await hrClient.get(`/api/hr/onboarding/drafts/${late.id}`)).body.data.draft.lifecycle, 'OFFER_SENT');
  });

  it('refuses to send an offer whose acceptance deadline has passed', async () => {
    await setSignatory(hrClient);
    const draft = await createDraft(hrClient, departmentId, {
      email: 'past.deadline@example.com',
      terms: { offerValidUntil: joiningIn(5) },
    });
    // Saved last week with a deadline that has since passed.
    const { ObjectId } = testServer.database.base.Types;
    await testServer.database
      .collection('onboardingdrafts')
      .updateOne(
        { _id: new ObjectId(draft.id) },
        { $set: { 'terms.offerValidUntil': new Date(Date.now() - 2 * DAY_MS) } },
      );
    const response = await hrClient.post(`/api/hr/onboarding/drafts/${draft.id}/dispatch`, {});
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'OFFER_EXPIRED');
    assert.equal(
      (await hrClient.get(`/api/hr/onboarding/drafts/${draft.id}`)).body.data.draft.status,
      'PENDING_REVIEW',
    );
    assert.equal(testServer.mailbox.messagesTo('past.deadline@example.com').length, 0);
  });
});

describe('onboarding offers: a failed email', { skip: pdfReason ?? false }, () => {
  let testServer;
  let hrClient;
  let departmentId;

  before(async () => {
    // No mail server: every email "fails", as when the provider is down.
    testServer = await startTestServer({ mail: false, environment: pdfEnvironment });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema@example.com', role: 'hr' });
    departmentId = await insertDepartment(testServer.database);
    await setSignatory(hrClient);
  });

  after(async () => {
    await testServer?.stop();
  });

  it('keeps the employee it created and resends through the same invitation', async () => {
    const draft = await createDraft(hrClient, departmentId, { email: 'retry@example.com' });
    const first = await hrClient.post(`/api/hr/onboarding/drafts/${draft.id}/dispatch`, {});
    assert.equal(first.status, 202, explain(testServer, first));
    assert.equal(first.body.message, ONBOARDING_MESSAGES.DISPATCH_EMAIL_FAILED);
    assert.equal(first.body.data.draft.status, 'DISPATCH_FAILED');
    const employeeCode = first.body.data.draft.dispatch.employeeCode;

    const second = await hrClient.post(`/api/hr/onboarding/drafts/${draft.id}/dispatch`, {});
    assert.equal(second.status, 202, explain(testServer, second));
    assert.equal(second.body.data.draft.dispatch.employeeCode, employeeCode);
    assert.equal(second.body.data.draft.dispatch.attempts, 2);
    const database = testServer.database;
    assert.equal(await database.collection('users').countDocuments({ email: 'retry@example.com' }), 1);
    assert.equal(await database.collection('employeeinvitations').countDocuments({ email: 'retry@example.com' }), 1);
    const invitation = await database.collection('employeeinvitations').findOne({ email: 'retry@example.com' });
    assert.equal(invitation.sendCount, 2);
  });
});
