/**
 * Offers from a CSV and bulk send (routes/onboardingRoutes.js POST /drafts/import and
 * /drafts/bulk-send) against the real server: valid rows become drafts waiting for review (nobody is
 * invited, nothing is sent); any row with a problem stops the whole file, every problem named by line
 * and column, including a split that does not add up (the single offer's own message); and a chosen
 * batch is sent one by one, each outcome reported, the drafts that cannot go named with their reason.
 * The sample company and people are invented.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ONBOARDING_MESSAGES } from '../../constants/messages.js';
import { isQpdfAvailable } from '../../services/pdfProtection.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const qpdfPath = process.env.QPDF_PATH || 'qpdf';
const pdfBrowserEnvironment = Object.fromEntries(
  ['PDF_BROWSER_CHANNEL', 'PDF_BROWSER_EXECUTABLE_PATH']
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
);
const mongoReason = await mongoUnavailableReason();
const pdfReason =
  mongoReason ??
  (Object.keys(pdfBrowserEnvironment).length === 0
    ? 'no PDF browser: set PDF_BROWSER_CHANNEL or PDF_BROWSER_EXECUTABLE_PATH'
    : (await isQpdfAvailable(qpdfPath))
      ? null
      : `qpdf not found at "${qpdfPath}"`);
if (process.env.CI === 'true' && pdfReason && !mongoReason) {
  throw new Error(`The bulk send tests cannot run in CI: ${pdfReason}`);
}

const joiningIn = (days) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
const HEADER =
  'name,personal_email,department_code,designation,manager_email,date_of_joining,date_of_birth,ctc,work_city,' +
  'professional_tax_state,fixed_base,hra,special_allowance,variable_pay,esop_units,probation_months,notice_period_days';
/** A cell as a spreadsheet writes it: quoted when it holds a comma or a quote. */
const csvCell = (value) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
/** A CSV of rows given as objects (missing cells are empty). */
const csvOf = (rows) =>
  [
    HEADER,
    ...rows.map((row) =>
      HEADER.split(',')
        .map((column) => csvCell(row[column] ?? ''))
        .join(','),
    ),
  ].join('\n');
const row = (overrides) => ({
  name: 'Asha Rao',
  personal_email: 'asha.rao@example.com',
  department_code: 'ENG',
  designation: 'Data Engineer',
  date_of_joining: joiningIn(30),
  date_of_birth: '1995-06-15',
  ctc: '25,00,000',
  work_city: 'Bengaluru',
  professional_tax_state: 'KA',
  ...overrides,
});
const upload = (client, rows) =>
  client.upload('/api/hr/onboarding/drafts/import', { fileName: 'offers.csv', content: csvOf(rows) });

describe('offer drafts from a CSV', { skip: mongoReason ?? false }, () => {
  let testServer;
  let hrClient;
  let manager;

  before(async () => {
    testServer = await startTestServer({ mail: false });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema@example.com', role: 'hr' });
    const engineering = await insertDepartment(testServer.database, { name: 'Engineering', code: 'ENG' });
    manager = await onboardEmployee({
      testServer,
      hrClient,
      email: 'lead.engineer@example.com',
      name: 'Lata Lead',
      departmentId: engineering,
    });
  });

  after(async () => {
    await testServer?.stop();
  });

  const draftCount = () => testServer.database.collection('onboardingdrafts').countDocuments();

  it('saves every row as a draft waiting for review, inviting and sending nothing', async () => {
    const response = await upload(hrClient, [
      row({
        manager_email: 'lead.engineer@example.com',
        fixed_base: '10,00,000',
        variable_pay: '2,50,000',
        esop_units: '1200',
        probation_months: '3',
        notice_period_days: '30',
      }),
      row({ name: 'Bilal Khan', personal_email: 'bilal.khan@example.com', ctc: '12,00,000' }),
    ]);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.message, ONBOARDING_MESSAGES.IMPORTED(2));
    const [asha, bilal] = response.body.data.drafts;
    assert.equal(asha.status, 'PENDING_REVIEW');
    assert.equal(asha.lifecycle, 'INVITED');
    assert.equal(asha.position.reportingManagerId, manager.profileId);
    assert.equal(asha.structure.fixedCtc.annual, 22_50_000);
    assert.equal(asha.structure.earnings.basic.annual, 10_00_000);
    assert.equal(asha.compensation.esopUnits, 1_200);
    assert.deepEqual([asha.terms.probationMonths, asha.terms.noticePeriodDays], [3, 30]);
    assert.equal(bilal.structure.annualCtc, 12_00_000);
    assert.equal(bilal.structure.variablePay.annual, 0);

    const single = await hrClient.post('/api/hr/onboarding/calculate', {
      name: 'Bilal Khan',
      email: 'bilal.khan@example.com',
      designation: 'Data Engineer',
      departmentId: bilal.position.departmentId,
      workLocationType: 'Onsite',
      dateOfJoining: joiningIn(30),
      employmentStatus: 'Probation',
      dateOfBirth: '1995-06-15',
      annualCtc: 12_00_000,
      workCity: 'Bengaluru',
      professionalTaxState: 'KA',
    });
    assert.deepEqual(bilal.structure, single.body.data.structure, 'a row is worked out as a single offer is');
    assert.equal(await testServer.database.collection('users').countDocuments({ email: 'bilal.khan@example.com' }), 0);
    assert.equal(await testServer.database.collection('employeeinvitations').countDocuments(), 1, 'only the manager’s');
  });

  it('creates nothing when any row has a problem, naming each by line and column', async () => {
    const draftsBefore = await draftCount();
    const components = { fixed_base: '10,00,000', hra: '4,00,000' };
    const response = await upload(hrClient, [
      row({ personal_email: 'ok.row@example.com' }),
      row({ personal_email: 'split@example.com', ...components, special_allowance: '1' }),
      row({ personal_email: 'nodept@example.com', department_code: 'XYZ' }),
      row({ personal_email: 'nomanager@example.com', manager_email: 'nobody@example.com' }),
      row({ personal_email: 'badctc@example.com', ctc: 'twenty lakh', date_of_birth: '' }),
      row({ personal_email: 'ok.row@example.com', name: 'Repeat Row' }),
      row({ personal_email: 'lead.engineer@example.com' }),
      row({ personal_email: 'asha.rao@example.com' }),
    ]);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.message, ONBOARDING_MESSAGES.IMPORT_ROWS_INVALID);
    const problems = response.body.error.details.map(({ line, field }) => `${line} ${field}`);
    assert.deepEqual(problems, [
      '3 special_allowance',
      '4 department_code',
      '5 manager_email',
      '6 date_of_birth',
      '6 ctc',
      '7 personal_email',
      '8 personal_email',
      '9 personal_email',
    ]);
    const split = response.body.error.details.find((detail) => detail.field === 'special_allowance');
    assert.match(split.message, /do not add up to the fixed CTC/);
    assert.match(response.body.error.details.find((detail) => detail.line === 9).message, /not settled/);
    assert.equal(
      response.body.error.details.find((detail) => detail.line === 4).message,
      'no active department has this code',
    );
    assert.match(response.body.error.details.find((detail) => detail.line === 8).message, /already has an account/);
    assert.equal(await draftCount(), draftsBefore, 'all or nothing');
  });

  it('refuses a file without the offer columns, and people who may not prepare offers', async () => {
    const missing = await hrClient.upload('/api/hr/onboarding/drafts/import', {
      fileName: 'offers.csv',
      content: 'name,personal_email\nAsha,asha@example.com\n',
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'COLUMNS_MISSING');
    const refused = await upload(manager.client, [row({ personal_email: 'someone@example.com' })]);
    assert.equal(refused.status, 403);
  });
});

describe('bulk send', { skip: pdfReason ?? false }, () => {
  let testServer;
  let hrClient;

  before(async () => {
    testServer = await startTestServer({ environment: { ...pdfBrowserEnvironment, QPDF_PATH: qpdfPath } });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema@example.com', role: 'hr' });
    await insertDepartment(testServer.database, { name: 'Engineering', code: 'ENG' });
    const { version } = (await hrClient.get('/api/hr/onboarding/settings')).body.data.settings;
    await hrClient.patch('/api/hr/onboarding/settings', {
      offerTerms: { signatoryName: 'Naren Kumar', signatoryTitle: 'Director' },
      version,
    });
  });

  after(async () => {
    await testServer?.stop();
  });

  it('sends a chosen batch one by one, reporting each outcome and the drafts that cannot go', async () => {
    const imported = await upload(hrClient, [
      row({ personal_email: 'first@example.com', name: 'First Person' }),
      row({ personal_email: 'second@example.com', name: 'Second Person' }),
      row({ personal_email: 'third@example.com', name: 'Third Person' }),
    ]);
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const [first, second, third] = imported.body.data.drafts;
    await hrClient.post(`/api/hr/onboarding/drafts/${third.id}/cancel`, { version: third.version });
    const missing = '65f1a2b3c4d5e6f708192a99';

    const response = await hrClient.post('/api/hr/onboarding/drafts/bulk-send', {
      draftIds: [first.id, second.id, third.id, missing],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { results, counts } = response.body.data;
    assert.deepEqual(counts, { sent: 2, email_failed: 0, refused: 2 });
    assert.equal(response.body.message, ONBOARDING_MESSAGES.BULK_SENT(counts));
    assert.deepEqual(
      results.map((result) => [result.draftId, result.outcome, result.code]),
      [
        [first.id, 'sent', null],
        [second.id, 'sent', null],
        [third.id, 'refused', 'DISPATCH_NOT_ALLOWED'],
        [missing, 'refused', 'DRAFT_NOT_FOUND'],
      ],
    );
    assert.equal(results[0].draft.lifecycle, 'OFFER_SENT');
    for (const address of ['first@example.com', 'second@example.com']) {
      const [email] = await testServer.mailbox.waitForMessages(address, 1);
      assert.equal(email.attachments[0].contentType, 'application/pdf');
    }
    assert.equal(testServer.mailbox.messagesTo('third@example.com').length, 0);

    const again = await hrClient.post('/api/hr/onboarding/drafts/bulk-send', { draftIds: [first.id] });
    assert.deepEqual(again.body.data.counts, { sent: 0, email_failed: 0, refused: 1 }, 'never sent twice');
    const invalid = await hrClient.post('/api/hr/onboarding/drafts/bulk-send', { draftIds: [] });
    assert.equal(invalid.status, 400);
  });
});
