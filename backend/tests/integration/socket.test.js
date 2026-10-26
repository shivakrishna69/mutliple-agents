/**
 * Real-time channel (utils/socketManager.js) through the real Socket.IO client: the handshake
 * checks, conversation rooms, live delivery, the admin-only telemetry channel, and sockets being
 * ended when the session or role changes.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

import {
  createSignedInClient,
  mongoUnavailableReason,
  startTestServer,
  TEST_ADMIN_EMAIL,
  TEST_APP_ORIGIN,
} from './testServer.js';

const skipReason = await mongoUnavailableReason();
const EVENT_TIMEOUT_MS = 5_000;

function openSocket(testServer, client, { origin = TEST_APP_ORIGIN } = {}) {
  return io(testServer.baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: { Origin: origin, ...(client ? { Cookie: client.cookieHeader() } : {}) },
  });
}

/** Resolves once connected; rejects with the server's connect_error. */
function connected(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function nextEvent(socket, eventName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No ${eventName} within ${EVENT_TIMEOUT_MS} ms`)),
      EVENT_TIMEOUT_MS,
    );
    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function request(socket, eventName, payload) {
  return socket.timeout(EVENT_TIMEOUT_MS).emitWithAck(eventName, payload);
}

describe('real-time channel', { skip: skipReason ?? false }, () => {
  let testServer;
  let adminClient;
  let agentClient;
  let customerClient;
  let otherCustomerClient;
  let customerId;
  const openSockets = [];

  async function connectAs(client) {
    const socket = openSocket(testServer, client);
    openSockets.push(socket);
    return connected(socket);
  }

  async function insertEscalatedConversation(ownerId) {
    const { insertedId } = await testServer.database.collection('conversations').insertOne({
      customerId: new testServer.database.base.Types.ObjectId(ownerId),
      status: 'escalated-to-human',
      assignedAgentId: null,
      currentActiveWorker: 'human',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return insertedId.toString();
  }

  before(async () => {
    testServer = await startTestServer();
    adminClient = await createSignedInClient(testServer, { name: 'Admin User', email: TEST_ADMIN_EMAIL });
    agentClient = await createSignedInClient(testServer, {
      name: 'Ari Agent',
      email: 'ari@example.com',
      role: 'agent',
    });
    customerClient = await createSignedInClient(testServer, { name: 'Cyrus Mehta', email: 'cyrus@example.com' });
    otherCustomerClient = await createSignedInClient(testServer, { name: 'Ola Other', email: 'ola@example.com' });
    customerId = (await customerClient.get('/api/auth/me')).body.data.user.id;
  });

  after(async () => {
    for (const socket of openSockets) socket.disconnect();
    await testServer?.stop();
  });

  it('refuses a connection without a session', async () => {
    const socket = openSocket(testServer, null);
    openSockets.push(socket);
    const connectionError = await connected(socket).then(
      () => assert.fail('connected without a session'),
      (error) => error,
    );
    assert.equal(typeof connectionError.data?.code, 'string');
  });

  it('refuses a connection from a site that is not allowed, even with a valid session', async () => {
    const socket = openSocket(testServer, customerClient, { origin: 'https://evil.example' });
    openSockets.push(socket);
    await assert.rejects(connected(socket));
  });

  it('lets customers join only their own conversations', async () => {
    const socket = await connectAs(customerClient);
    const ownConversationId = await insertEscalatedConversation(customerId);
    const otherConversationId = await insertEscalatedConversation(
      (await otherCustomerClient.get('/api/auth/me')).body.data.user.id,
    );

    assert.equal(
      (await request(socket, 'JOIN_CONVERSATION', { conversationId: 'not-an-id' })).error.code,
      'invalid_payload',
    );
    assert.equal(
      (await request(socket, 'JOIN_CONVERSATION', { conversationId: otherConversationId })).error.code,
      'conversation_not_accessible',
    );
    const joinAck = await request(socket, 'JOIN_CONVERSATION', { conversationId: ownConversationId });
    assert.equal(joinAck.ok, true);
    assert.equal(joinAck.conversation.status, 'escalated-to-human');
  });

  it('delivers an agent claim and reply to the customer live', async () => {
    const conversationId = await insertEscalatedConversation(customerId);
    const customerSocket = await connectAs(customerClient);
    assert.equal((await request(customerSocket, 'JOIN_CONVERSATION', { conversationId })).ok, true);

    const statusUpdate = nextEvent(customerSocket, 'CONVERSATION_STATUS_UPDATED');
    const claimResponse = await agentClient.post(`/api/conversations/${conversationId}/claim`);
    assert.equal(claimResponse.status, 200, JSON.stringify(claimResponse.body));
    assert.equal((await statusUpdate).status, 'assigned-agent');

    const newMessage = nextEvent(customerSocket, 'NEW_MESSAGE');
    const replyResponse = await agentClient.post(`/api/conversations/${conversationId}/messages`, {
      text: 'Hi Cyrus, I am looking at this now.',
    });
    assert.equal(replyResponse.status, 201, JSON.stringify(replyResponse.body));
    const deliveredMessage = await newMessage;
    assert.equal(deliveredMessage.text, 'Hi Cyrus, I am looking at this now.');
    assert.equal(deliveredMessage.conversationId, conversationId);
    // Customers get the reduced payload: no internal tool logs or staff identities.
    assert.equal(deliveredMessage.toolExecutionLogs, undefined);
    assert.equal(deliveredMessage.senderUserId, undefined);
  });

  it('keeps the agent telemetry channel to admins', async () => {
    const customerSocket = await connectAs(customerClient);
    assert.equal((await request(customerSocket, 'SUBSCRIBE_AGENT_TELEMETRY', {})).error.code, 'telemetry_forbidden');

    const adminSocket = await connectAs(adminClient);
    assert.equal((await request(adminSocket, 'SUBSCRIBE_AGENT_TELEMETRY', {})).ok, true);
  });

  it('ends the sockets of a user whose role an admin changes', async () => {
    const otherCustomerSocket = await connectAs(otherCustomerClient);
    const sessionEnded = nextEvent(otherCustomerSocket, 'SESSION_ENDED');
    const otherCustomerId = (await otherCustomerClient.get('/api/auth/me')).body.data.user.id;

    const roleResponse = await adminClient.patch(`/api/admin/users/${otherCustomerId}/role`, { role: 'agent' });
    assert.equal(roleResponse.status, 200, JSON.stringify(roleResponse.body));
    assert.equal((await sessionEnded).code, 'role_changed');
  });

  it('ends the socket when its session logs out', async () => {
    const socket = await connectAs(customerClient);
    const sessionEnded = nextEvent(socket, 'SESSION_ENDED');
    const disconnected = nextEvent(socket, 'disconnect');

    assert.equal((await customerClient.post('/api/auth/logout')).status, 200);
    assert.equal((await sessionEnded).code, 'session_logged_out');
    await disconnected;
  });
});
