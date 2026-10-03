/**
 * Developer tool: sends a customer message through the real inbound webhook, signed with
 * WEBHOOK_SIGNING_SECRET from backend/.env, exactly as an external channel would. Use it to create
 * conversations to work on in the support console while there is no customer chat UI.
 *
 * Usage (from the backend directory, with the backend running):
 *   npm run send-test-message -- <customer email> "<message text>"
 *   node scripts/sendTestMessage.js priya@example.com "I was charged twice and the app crashes"
 *
 * The email must belong to a registered customer (sign up first). The message goes through the full
 * pipeline: saved, sent to the AI service, answered or escalated, and published to open consoles.
 * Set BACKEND_URL to target a backend other than http://localhost:<PORT from .env or 5000>.
 *
 * Exit codes: 0 delivered, 1 invalid arguments, 2 rejected by the backend, 3 configuration or network error.
 */

import 'dotenv/config';
import { createHmac, randomUUID } from 'node:crypto';

function printUsage() {
  console.error('Usage: node scripts/sendTestMessage.js <customer email> "<message text>"');
}

async function main() {
  const [senderEmail, ...messageWords] = process.argv.slice(2);
  const messageText = messageWords.join(' ').trim();
  if (!senderEmail || !messageText) {
    printUsage();
    return 1;
  }
  const signingSecret = process.env.WEBHOOK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error('WEBHOOK_SIGNING_SECRET is not set (expected in backend/.env)');
    return 3;
  }

  const backendUrl = (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/+$/, '');
  const rawBody = JSON.stringify({ eventId: `dev-${randomUUID()}`, senderEmail, text: messageText });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac('sha256', signingSecret).update(`${timestamp}.${rawBody}`).digest('hex')}`;

  let response;
  try {
    response = await fetch(`${backendUrl}/api/webhooks/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': signature },
      body: rawBody,
    });
  } catch (networkError) {
    console.error(`Could not reach ${backendUrl}: ${networkError.message}. Is the backend running?`);
    return 3;
  }

  const responseBody = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`Rejected (HTTP ${response.status}): ${responseBody?.error?.message ?? 'no details'}`);
    return 2;
  }
  const { outcome, conversation, reply } = responseBody.data;
  console.log(`Delivered. Outcome: ${outcome}. Conversation ${conversation?.id} is now "${conversation?.status}".`);
  if (reply) console.log(`Reply (${reply.senderType}): ${reply.text}`);
  return 0;
}

process.exitCode = await main();
