/**
 * The dashboard (GET /api/dashboard/overview) and the services' health (GET /api/system/health):
 * each section only for the roles allowed to see it, every figure against data built by hand, the
 * agent's recent list limited to what an agent may see, and health reported without details.
 */

import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DASHBOARD_MESSAGES, SYSTEM_HEALTH_MESSAGES } from '../../constants/messages.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer, TEST_ADMIN_EMAIL } from './testServer.js';

const skipReason = await mongoUnavailableReason();
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;

/** A stand-in AI service whose /health answers `status`. */
async function startAiStandIn(status) {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? status : 404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const overviewOf = async (client, query = '') => {
  const response = await client.get(`/api/dashboard/overview${query}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
};

describe('dashboard sections by role', { skip: skipReason ?? false }, () => {
  let testServer;
  let clients;

  before(async () => {
    testServer = await startTestServer({ mail: false });
    clients = {
      admin: await createSignedInClient(testServer, { name: 'Ada Admin', email: TEST_ADMIN_EMAIL }),
      hr: await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema@example.com', role: 'hr' }),
      agent: await createSignedInClient(testServer, { name: 'Arun Agent', email: 'arun@example.com', role: 'agent' }),
      employee: await createSignedInClient(testServer, { name: 'Cyrus', email: 'cyrus@example.com' }),
    };
  });

  after(async () => {
    await testServer?.stop();
  });

  it('gives each role only its own sections', async () => {
    const present = async (role) =>
      Object.entries(await overviewOf(clients[role]))
        .filter(([key, value]) => ['people', 'support', 'accounts', 'me'].includes(key) && value !== null)
        .map(([key]) => key)
        .sort();
    assert.deepEqual(await present('admin'), ['accounts', 'people', 'support']);
    assert.deepEqual(await present('hr'), ['people']);
    assert.deepEqual(await present('agent'), ['support']);
    assert.deepEqual(await present('employee'), []);
  });

  it('defaults to today, offers its three ranges, and refuses any other', async () => {
    const overview = await overviewOf(clients.admin);
    assert.equal(overview.range.key, 'today');
    assert.equal(overview.range.timeZone, 'Asia/Kolkata');
    // "Today" is the company's date, which can differ from the server's (UTC) date.
    const companyToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    assert.equal(overview.range.lastDate, companyToday);
    assert.deepEqual(
      overview.ranges.map((range) => range.key),
      ['today', '7d', '30d'],
    );
    assert.equal(overview.support.activity.unit, 'hour');
    assert.equal(overview.support.activity.points.length, 24);
    assert.ok(overview.support.activity.points.every((point) => point.key.startsWith(`${companyToday}T`)));

    const refused = await clients.admin.get('/api/dashboard/overview?range=week');
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body.error.details, [{ field: 'range', message: DASHBOARD_MESSAGES.RANGE_INVALID }]);
    assert.equal((await testServer.createClient().get('/api/dashboard/overview')).status, 401);
  });

  it('counts accounts per role and the new ones of the last 7 days', async () => {
    await testServer.database.collection('users').insertOne({
      name: 'Old Timer',
      email: 'old@example.com',
      role: 'employee',
      status: 'active',
      createdAt: new Date(Date.now() - 30 * DAY),
      updatedAt: new Date(Date.now() - 30 * DAY),
    });
    const { accounts } = await overviewOf(clients.admin);
    assert.deepEqual(accounts.perRole, { admin: 1, hr: 1, finance: 0, it_admin: 0, agent: 1, employee: 2 });
    assert.equal(accounts.total, 5);
    assert.equal(accounts.newThisWeek, 4);
  });
});

describe('dashboard support figures', { skip: skipReason ?? false }, () => {
  let testServer;
  let adminClient;
  let agentClient;
  const ids = {};

  before(async () => {
    testServer = await startTestServer({ mail: false });
    adminClient = await createSignedInClient(testServer, { name: 'Ada Admin', email: TEST_ADMIN_EMAIL });
    agentClient = await createSignedInClient(testServer, { name: 'Arun', email: 'arun@example.com', role: 'agent' });
    const users = testServer.database.collection('users');
    const adminId = (await users.findOne({ email: TEST_ADMIN_EMAIL }))._id;
    const agentId = (await users.findOne({ email: 'arun@example.com' }))._id;
    const { insertedId: customerId } = await users.insertOne({
      name: 'Sarah Jenkins',
      email: 'sarah@example.com',
      role: 'employee',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Opened two hours ago, so inside the last 30 days whatever the hour of the run.
    const t0 = new Date(Date.now() - 2 * 60 * 60 * SECOND);
    const at = (base, offsetMs) => new Date(base.getTime() + offsetMs);
    const conversation = (key, status, { opened = t0, assignedAgentId = null, updatedAt = opened } = {}) => {
      const document = {
        customerId,
        status,
        assignedAgentId,
        currentActiveWorker: assignedAgentId ? 'human' : 'supervisor',
        createdAt: opened,
        updatedAt,
      };
      ids[key] = document;
      return document;
    };
    const conversations = testServer.database.collection('conversations');
    const fortyDaysAgo = new Date(Date.now() - 40 * DAY);
    const inserted = await conversations.insertMany([
      conversation('aiOnly', 'processing-ai', { updatedAt: at(t0, 10 * SECOND) }),
      conversation('aiThenAgent', 'assigned-agent', { assignedAgentId: adminId, updatedAt: at(t0, 50 * SECOND) }),
      conversation('waiting', 'escalated-to-human', { updatedAt: at(t0, 40 * SECOND) }),
      conversation('agentOnly', 'assigned-agent', { assignedAgentId: agentId, updatedAt: at(t0, 30 * SECOND) }),
      conversation('previous', 'processing-ai', { opened: fortyDaysAgo, updatedAt: fortyDaysAgo }),
    ]);
    for (const [index, key] of ['aiOnly', 'aiThenAgent', 'waiting', 'agentOnly', 'previous'].entries()) {
      ids[key] = inserted.insertedIds[index];
    }
    const message = (key, senderType, createdAt, text = `${senderType} message`) => ({
      conversationId: ids[key],
      senderType,
      text,
      toolExecutionLogs: [],
      createdAt,
      updatedAt: createdAt,
    });
    await testServer.database
      .collection('messages')
      .insertMany([
        message('aiOnly', 'customer', t0),
        message('aiOnly', 'ai_worker', at(t0, 2 * SECOND)),
        message('aiThenAgent', 'customer', t0),
        message('aiThenAgent', 'ai_supervisor', at(t0, 4 * SECOND)),
        message('aiThenAgent', 'human_agent', at(t0, 90 * SECOND), 'Invoice #4892 has been re-issued.'),
        message('waiting', 'customer', t0, 'I need a person, please.'),
        message('agentOnly', 'customer', t0),
        message('agentOnly', 'human_agent', at(t0, 120 * SECOND)),
        message('previous', 'customer', fortyDaysAgo),
        message('previous', 'ai_worker', at(fortyDaysAgo, 10 * SECOND)),
      ]);
  });

  after(async () => {
    await testServer?.stop();
  });

  it('counts the queue as it is now', async () => {
    const { support } = await overviewOf(adminClient, '?range=30d');
    assert.deepEqual(support.queue, {
      waitingForAgent: 1,
      assignedToYou: 1,
      withAgents: 2,
      withAi: 2,
      statusCounts: { unassigned: 0, 'assigned-agent': 2, 'processing-ai': 2, 'escalated-to-human': 1 },
    });
  });

  it('measures the conversations opened in the range from their messages', async () => {
    const { support } = await overviewOf(adminClient, '?range=30d');
    assert.deepEqual(support.period, {
      conversations: 4,
      // Only aiOnly: the others had an agent reply or are owned by one.
      handledByAiShare: 0.25,
      escalationShare: 0.75,
      // First replies after 2 s, 4 s and 120 s (the waiting one has none yet).
      avgFirstResponseMs: 42000,
      withinTargetShare: 0.667,
      // The AI's first replies: 2 s and 4 s.
      medianAiReplyMs: 3000,
      firstResponseTargetMs: 60000,
    });
  });

  it('compares with the same stretch of the previous period', async () => {
    const { support } = await overviewOf(adminClient, '?range=30d');
    // The previous 30 days held one conversation, answered by the AI in 10 s.
    assert.deepEqual(support.change, {
      conversations: 3,
      handledByAiShare: -0.75,
      avgFirstResponseMs: 32000,
      medianAiReplyMs: -7000,
    });
  });

  it('counts AI and agent replies over the range, by day', async () => {
    const { support } = await overviewOf(adminClient, '?range=30d');
    assert.equal(support.activity.unit, 'day');
    assert.equal(support.activity.points.length, 30);
    const totals = support.activity.points.reduce(
      (sum, point) => ({ ai: sum.ai + point.ai, agent: sum.agent + point.agent }),
      { ai: 0, agent: 0 },
    );
    assert.deepEqual(totals, { ai: 2, agent: 2 });
  });

  it('has nothing to measure for a period without conversations', async () => {
    await testServer.database
      .collection('conversations')
      .updateMany({}, { $set: { createdAt: new Date(Date.now() - 90 * DAY) } });
    const { support } = await overviewOf(adminClient, '?range=7d');
    assert.equal(support.period.conversations, 0);
    assert.equal(support.period.avgFirstResponseMs, null);
    assert.equal(support.period.handledByAiShare, null);
    assert.equal(support.change.avgFirstResponseMs, null);

    // A conversation nobody has answered yet: there is no first reply to judge, so "within
    // target" has nothing to measure (it is not 0%, which would read as every reply being late).
    const users = testServer.database.collection('users');
    const { _id: customerId } = await users.findOne({ email: 'sarah@example.com' });
    const longAgo = new Date(Date.now() - 100 * DAY); // last-updated long ago, so it stays off the recent list
    const { insertedId } = await testServer.database.collection('conversations').insertOne({
      customerId,
      status: 'processing-ai',
      assignedAgentId: null,
      currentActiveWorker: 'supervisor',
      createdAt: new Date(Date.now() - 60 * SECOND),
      updatedAt: longAgo,
    });
    await testServer.database.collection('messages').insertOne({
      conversationId: insertedId,
      senderType: 'customer',
      text: 'Hello?',
      toolExecutionLogs: [],
      createdAt: new Date(Date.now() - 60 * SECOND),
      updatedAt: new Date(Date.now() - 60 * SECOND),
    });
    const { support: unanswered } = await overviewOf(adminClient, '?range=7d');
    assert.equal(unanswered.period.conversations, 1);
    assert.equal(unanswered.period.handledByAiShare, 0);
    assert.equal(unanswered.period.avgFirstResponseMs, null);
    assert.equal(unanswered.period.withinTargetShare, null);
    assert.equal(unanswered.period.medianAiReplyMs, null);
  });

  it('lists the newest conversations the viewer may see, with the last message', async () => {
    const { support: forAdmin } = await overviewOf(adminClient);
    assert.deepEqual(
      forAdmin.recent.map((conversation) => conversation.id),
      ['aiThenAgent', 'waiting', 'agentOnly', 'aiOnly', 'previous'].map((key) => ids[key].toString()),
    );
    const [first] = forAdmin.recent;
    assert.equal(first.customerName, 'Sarah Jenkins');
    assert.equal(first.assignedToYou, true);
    assert.deepEqual(
      { senderType: first.lastMessage.senderType, text: first.lastMessage.text },
      { senderType: 'human_agent', text: 'Invoice #4892 has been re-issued.' },
    );

    // An agent sees their own conversations and the unclaimed escalated ones, nothing else.
    const { support: forAgent } = await overviewOf(agentClient);
    assert.deepEqual(
      forAgent.recent.map((conversation) => conversation.id),
      ['waiting', 'agentOnly'].map((key) => ids[key].toString()),
    );
  });

  it('puts a reply in the company’s local hour, not the server’s', async () => {
    // One minute after the company's midnight: in UTC (the server's clock) it is still yesterday
    // evening (18:31 for Kolkata), so a chart grouped in UTC would put it in the wrong hour and day.
    const { range } = await overviewOf(adminClient);
    const justAfterMidnight = new Date(new Date(range.start).getTime() + 60 * SECOND);
    await testServer.database.collection('messages').insertOne({
      conversationId: ids.aiOnly,
      senderType: 'ai_worker',
      text: 'Good morning',
      toolExecutionLogs: [],
      createdAt: justAfterMidnight,
      updatedAt: justAfterMidnight,
    });
    const { support } = await overviewOf(adminClient);
    const firstHour = support.activity.points[0];
    assert.equal(firstHour.key, `${range.lastDate}T00`);
    assert.equal(firstHour.label, '00:00');
    assert.equal(firstHour.ai, 1);
  });
});

describe('dashboard people and self-service', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let employee;
  const nextYear = new Date().getUTCFullYear() + 1;

  before(async () => {
    testServer = await startTestServer({ mail: true });
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema@example.com', role: 'hr' });
    const departmentId = await insertDepartment(testServer.database);
    employee = await onboardEmployee({
      testServer,
      hrClient,
      email: 'esha@example.com',
      name: 'Esha Iyer',
      departmentId,
    });
    for (const [name, date] of [
      ['Republic Day', `${nextYear}-01-26`],
      ['Holi', `${nextYear}-03-04`],
      ['Independence Day', `${nextYear}-08-15`],
      ['Gandhi Jayanti', `${nextYear}-10-02`],
    ]) {
      const created = await hrClient.post('/api/work-calendar/holidays', { name, date, officeLocationIds: [] });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }
  });

  after(async () => {
    await testServer?.stop();
  });

  it('agrees with the Attendance, Presence, Leave and Employees pages', async () => {
    const { people } = await overviewOf(hrClient);
    const board = (await hrClient.get('/api/attendance/today')).body.data;
    assert.deepEqual(people.attendance, {
      employees: board.people.length,
      present: board.counts.in + board.counts.out,
      late: board.counts.late,
      onLeave: board.counts.on_leave,
      notInYet: board.counts.not_in,
      dayOff: board.counts.holiday + board.counts.weekly_off,
      withoutOffice: board.counts.no_office,
    });
    assert.deepEqual(people.presence, (await hrClient.get('/api/presence/now')).body.data.counts);
    const queue = (await hrClient.get('/api/leave/approvals?queue=requests')).body.data.requests;
    assert.equal(people.waiting.leaveRequests, queue.length);
    const employees = (await hrClient.get('/api/employees')).body.data.employees;
    assert.equal(people.headcount.employees, employees.length);
  });

  it('counts this month’s joiners and groups the headcount by department', async () => {
    const { people } = await overviewOf(hrClient);
    assert.equal(people.headcount.employees, 1);
    assert.equal(people.headcount.joinersThisMonth, 1);
    assert.deepEqual(
      people.headcount.byDepartment.map(({ name, count }) => ({ name, count })),
      [{ name: 'Operations', count: 1 }],
    );
  });

  it('leaves presence out once the company switches it off', async () => {
    const adminClient = await createSignedInClient(testServer, { name: 'Ada', email: TEST_ADMIN_EMAIL });
    const { version } = (await adminClient.get('/api/company/settings')).body.data.settings;
    const switchedOff = await adminClient.patch('/api/company/settings', { presence: { enabled: false }, version });
    assert.equal(switchedOff.status, 200, JSON.stringify(switchedOff.body));
    assert.equal((await overviewOf(hrClient)).people.presence, null);
    const { version: newVersion } = switchedOff.body.data.settings;
    await adminClient.patch('/api/company/settings', { presence: { enabled: true }, version: newVersion });
  });

  it('lists the next three holidays, soonest first', async () => {
    const { people } = await overviewOf(hrClient);
    assert.deepEqual(
      people.holidays.map((holiday) => holiday.name),
      ['Republic Day', 'Holi', 'Independence Day'],
    );
  });

  it('shows the employee their own day, and nobody else’s sections', async () => {
    const overview = await overviewOf(employee.client);
    assert.equal(overview.people, null);
    assert.equal(overview.support, null);
    assert.equal(overview.accounts, null);
    const { me } = overview;
    assert.equal(me.today.date, overview.range.lastDate);
    assert.equal(me.today.checkInTime, null);
    assert.ok(Array.isArray(me.leaveBalances));
    assert.equal(me.pendingLeave, 0);
    assert.equal(me.latestPayslip, null);
    assert.deepEqual(me.nextHoliday && { name: me.nextHoliday.name, date: me.nextHoliday.date }, {
      name: 'Republic Day',
      date: `${nextYear}-01-26`,
    });
  });
});

describe('services health', { skip: skipReason ?? false }, () => {
  const servers = [];
  const standIns = [];

  after(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    await Promise.all(standIns.map((standIn) => standIn.close()));
  });

  async function adminOf(options) {
    const testServer = await startTestServer(options);
    servers.push(testServer);
    return { testServer, admin: await createSignedInClient(testServer, { name: 'Ada', email: TEST_ADMIN_EMAIL }) };
  }

  const statusesOf = (health) => Object.fromEntries(health.services.map((service) => [service.key, service.status]));

  it('reports every service as operational when they all answer', async () => {
    const aiService = await startAiStandIn(200);
    standIns.push(aiService);
    const { admin } = await adminOf({ aiServiceUrl: aiService.url, mail: true });
    const response = await admin.get('/api/system/health');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.message, SYSTEM_HEALTH_MESSAGES.RETRIEVED);
    const health = response.body.data;
    assert.deepEqual(statusesOf(health), {
      aiService: 'operational',
      email: 'operational',
      database: 'operational',
      cache: 'operational',
    });
    assert.equal(health.overall, 'operational');
    assert.ok(health.services.every((service) => service.label && Number.isInteger(service.responseMs)));
    // States and timings only: no addresses or hosts.
    assert.doesNotMatch(JSON.stringify(health), /127\.0\.0\.1|localhost|mongodb|smtp/i);
  });

  it('marks the AI service degraded, down, and email not set up, as they are', async () => {
    const degradedAi = await startAiStandIn(503);
    standIns.push(degradedAi);
    const { admin: withDegradedAi } = await adminOf({ aiServiceUrl: degradedAi.url, mail: false });
    const degraded = (await withDegradedAi.get('/api/system/health')).body.data;
    assert.equal(statusesOf(degraded).aiService, 'degraded');
    assert.equal(statusesOf(degraded).email, 'not_configured');
    assert.equal(degraded.overall, 'degraded');

    // The default test address has nothing listening.
    const { admin: withoutAi } = await adminOf({ mail: false });
    const down = (await withoutAi.get('/api/system/health')).body.data;
    assert.equal(statusesOf(down).aiService, 'down');
    assert.equal(down.overall, 'degraded');
  });

  it('is for administrators only', async () => {
    const { testServer } = await adminOf({ mail: false });
    const hr = await createSignedInClient(testServer, { name: 'Hema', email: 'hema@example.com', role: 'hr' });
    const refused = await hr.get('/api/system/health');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.message, SYSTEM_HEALTH_MESSAGES.ADMIN_ONLY);
    assert.equal((await testServer.createClient().get('/api/system/health')).status, 401);
  });
});
