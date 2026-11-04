/**
 * Company settings (routes/companyRoutes.js) against the real server: the settings a new
 * installation starts with, the public branding, who may read and change them, partial colour
 * changes, version checks and the model's field rules.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSignedInClient, mongoUnavailableReason, startTestServer, TEST_ADMIN_EMAIL } from './testServer.js';

const skipReason = await mongoUnavailableReason();

describe('company settings', { skip: skipReason ?? false }, () => {
  let testServer;
  let adminClient;
  let hrClient;
  let customerClient;

  before(async () => {
    testServer = await startTestServer();
    adminClient = await createSignedInClient(testServer, { name: 'Ada Admin', email: TEST_ADMIN_EMAIL });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    customerClient = await createSignedInClient(testServer, { name: 'Cyrus', email: 'cyrus@example.com' });
  });

  after(async () => {
    await testServer?.stop();
  });

  async function readSettings(client = adminClient) {
    const response = await client.get('/api/company/settings');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data.settings;
  }

  it('starts with the deployment name and the defaults, and shows branding without signing in', async () => {
    const settings = await readSettings();
    assert.deepEqual(settings, {
      name: 'Test Company',
      shortCode: 'NSK',
      emailDomain: null,
      logoUrl: null,
      brandColors: { primary: '#c75000', accent: '#282828' },
      timeZone: 'Asia/Kolkata',
      employeeIdDigits: 4,
      presence: { enabled: true, awayAfterMinutes: 5, detailRetentionDays: 90, summaryRetentionDays: 730 },
      version: 0,
    });
    const branding = await testServer.createClient().get('/api/company/branding');
    assert.equal(branding.status, 200);
    assert.deepEqual(branding.body.data.branding, {
      name: 'Test Company',
      shortCode: 'NSK',
      logoUrl: null,
      brandColors: { primary: '#c75000', accent: '#282828' },
    });
  });

  it('lets HR read the settings, only administrators change them, and nobody else see them', async () => {
    assert.equal((await readSettings(hrClient)).name, 'Test Company');
    assert.equal((await customerClient.get('/api/company/settings')).status, 403);
    const hrChange = await hrClient.patch('/api/company/settings', { name: 'Renamed', version: 0 });
    assert.equal(hrChange.status, 403);
    assert.equal(hrChange.body.error.code, 'ADMINS_ONLY');
    assert.equal((await customerClient.patch('/api/company/settings', { name: 'Renamed', version: 0 })).status, 403);
    assert.equal((await readSettings()).name, 'Test Company');
  });

  it('applies an administrator’s changes, one colour at a time, and refuses an outdated version', async () => {
    const changed = await adminClient.patch('/api/company/settings', {
      name: 'NSK Software Technologies',
      shortCode: 'nsk',
      emailDomain: 'NSKsofttech.in',
      logoUrl: 'https://nsksofttech.in/logo.png',
      brandColors: { primary: '#AA3300' },
      ignoredField: 'dropped',
      version: 0,
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const settings = changed.body.data.settings;
    assert.equal(settings.shortCode, 'NSK');
    assert.equal(settings.emailDomain, 'nsksofttech.in');
    assert.deepEqual(settings.brandColors, { primary: '#aa3300', accent: '#282828' });
    assert.equal(settings.version, 1);

    const stale = await adminClient.patch('/api/company/settings', { name: 'Late edit', version: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_VERSION');
    assert.equal((await readSettings()).name, 'NSK Software Technologies');
  });

  it('refuses values the model does not accept, naming each field', async () => {
    const { version } = await readSettings();
    const invalid = await adminClient.patch('/api/company/settings', {
      shortCode: 'N5K',
      emailDomain: 'not a domain',
      logoUrl: 'http://insecure.example.com/logo.png',
      brandColors: { accent: 'orange' },
      timeZone: 'Mars/Olympus',
      employeeIdDigits: 12,
      version,
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.error.details.map((detail) => detail.field).sort(), [
      'brandColors.accent',
      'emailDomain',
      'employeeIdDigits',
      'logoUrl',
      'shortCode',
      'timeZone',
    ]);
    const empty = await adminClient.patch('/api/company/settings', { version });
    assert.equal(empty.status, 400);
    const siteRelativeLogo = await adminClient.patch('/api/company/settings', {
      logoUrl: '/brand/nsk-logo.png',
      emailDomain: null,
      version,
    });
    assert.equal(siteRelativeLogo.status, 200, JSON.stringify(siteRelativeLogo.body));
  });
});
