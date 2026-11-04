/**
 * Live presence over Socket.IO against the real server (utils/realtime/presenceHandlers.js): an
 * employee's devices report activity, their status follows (available, away, offline when the last
 * device goes), and HR and their manager receive each change; nothing is recorded before the notice
 * is acknowledged, and people without a team cannot follow anyone.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

import { PRESENCE_NOTICE_VERSION } from '../../constants/validation.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer, TEST_APP_ORIGIN } from './testServer.js';

const skipReason = await mongoUnavailableReason();
const EVENT_TIMEOUT_MS = 5_000;

describe('live presence', { skip: skipReason ?? false }, () => {
  let testServer;
  let hrClient;
  let manager;
  let employee;
  let outsider;
  const openSockets = [];

  before(async () => {
    testServer = await startTestServer();
    hrClient = await createSignedInClient(testServer, { name: 'Hema HR', email: 'hema.hr@example.com', role: 'hr' });
    const departmentId = await insertDepartment(testServer.database);
    manager = await onboardEmployee({
      testServer,
      hrClient,
      email: 'lead@example.com',
      departmentId,
      name: 'Lata Lead',
    });
    employee = await onboardEmployee({
      testServer,
      hrClient,
      email: 'arun@example.com',
      departmentId,
      name: 'Arun',
      reportingManagerId: manager.profileId,
    });
    outsider = await onboardEmployee({ testServer, hrClient, email: 'farah@example.com', departmentId, name: 'Farah' });
  });

  after(async () => {
    for (const socket of openSockets) socket.disconnect();
    await testServer?.stop();
  });

  function connectAs(client) {
    const socket = io(testServer.baseUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { Origin: TEST_APP_ORIGIN, Cookie: client.cookieHeader() },
    });
    openSockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }

  const send = (socket, eventName, payload) =>
    new Promise((resolve) =>
      payload === undefined ? socket.emit(eventName, resolve) : socket.emit(eventName, payload, resolve),
    );

  /** The next PRESENCE_UPDATED about `employeeId` with `status`. */
  function presenceUpdate(socket, employeeId, status) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No ${status} update for ${employeeId} within ${EVENT_TIMEOUT_MS} ms`)),
        EVENT_TIMEOUT_MS,
      );
      const listener = (update) => {
        if (update.employeeId !== employeeId || update.status !== status) return;
        clearTimeout(timer);
        socket.off('PRESENCE_UPDATED', listener);
        resolve(update);
      };
      socket.on('PRESENCE_UPDATED', listener);
    });
  }

  it('records nothing before the employee acknowledges the notice', async () => {
    const laptop = await connectAs(employee.client);
    const refused = await send(laptop, 'PRESENCE_REPORT', { activity: 'active' });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'presence_not_recorded');
    assert.equal(await testServer.database.collection('presenceintervals').countDocuments(), 0);
    laptop.disconnect();
  });

  it('lets HR and managers follow presence, and nobody without a team', async () => {
    const hrSocket = await connectAs(hrClient);
    assert.deepEqual(await send(hrSocket, 'SUBSCRIBE_PRESENCE'), { ok: true, scope: 'organisation' });
    const managerSocket = await connectAs(manager.client);
    assert.deepEqual(await send(managerSocket, 'SUBSCRIBE_PRESENCE'), { ok: true, scope: 'direct_reports' });
    const outsiderSocket = await connectAs(outsider.client);
    const refused = await send(outsiderSocket, 'SUBSCRIBE_PRESENCE');
    assert.equal(refused.error.code, 'presence_forbidden');
  });

  it('follows an employee across devices: available, away, available, then offline', async () => {
    assert.equal(
      (await employee.client.post('/api/presence/notice', { version: PRESENCE_NOTICE_VERSION })).status,
      200,
    );
    const hrSocket = await connectAs(hrClient);
    await send(hrSocket, 'SUBSCRIBE_PRESENCE');
    const managerSocket = await connectAs(manager.client);
    await send(managerSocket, 'SUBSCRIBE_PRESENCE');
    const outsiderSocket = await connectAs(outsider.client);
    const outsiderUpdates = [];
    outsiderSocket.on('PRESENCE_UPDATED', (update) => outsiderUpdates.push(update));

    const laptop = await connectAs(employee.client);
    const ownUpdates = [];
    laptop.on('PRESENCE_UPDATED', (update) => ownUpdates.push(update));
    const hrSeesAvailable = presenceUpdate(hrSocket, employee.profileId, 'available');
    const managerSeesAvailable = presenceUpdate(managerSocket, employee.profileId, 'available');
    assert.deepEqual(await send(laptop, 'PRESENCE_REPORT', { activity: 'active' }), { ok: true, status: 'available' });
    const update = await hrSeesAvailable;
    await managerSeesAvailable;
    assert.equal(update.userId, employee.userId);
    assert.ok(update.since);

    const hrSeesAway = presenceUpdate(hrSocket, employee.profileId, 'away');
    assert.deepEqual(await send(laptop, 'PRESENCE_REPORT', { activity: 'idle' }), { ok: true, status: 'away' });
    await hrSeesAway;
    // The same report again is not a change, and is not published.
    assert.deepEqual(await send(laptop, 'PRESENCE_REPORT', { activity: 'idle' }), { ok: true, status: 'away' });

    const phone = await connectAs(employee.client);
    const hrSeesAvailableAgain = presenceUpdate(hrSocket, employee.profileId, 'available');
    assert.deepEqual(await send(phone, 'PRESENCE_REPORT', { activity: 'active' }), { ok: true, status: 'available' });
    await hrSeesAvailableAgain;

    // The laptop goes: the phone is still active. Then the phone goes too.
    laptop.disconnect();
    const hrSeesOffline = presenceUpdate(hrSocket, employee.profileId, 'offline');
    await new Promise((resolve) => setTimeout(resolve, 300));
    phone.disconnect();
    await hrSeesOffline;

    const intervals = await testServer.database
      .collection('presenceintervals')
      .find({}, { sort: { startedAt: 1 } })
      .toArray();
    assert.deepEqual(
      intervals.map((interval) => interval.state),
      ['available', 'away', 'available'],
    );
    assert.ok(intervals.every((interval) => interval.isOpen === false && interval.endedAt));
    assert.deepEqual(
      ownUpdates.map((ownUpdate) => ownUpdate.status),
      ['available', 'away', 'available'],
      'the employee sees their own changes',
    );
    assert.deepEqual(outsiderUpdates, [], 'someone outside the team sees nothing');
  });

  it('refuses reports that are not active or idle', async () => {
    const laptop = await connectAs(employee.client);
    const refused = await send(laptop, 'PRESENCE_REPORT', { activity: 'typing' });
    assert.equal(refused.error.code, 'invalid_payload');
  });
});
