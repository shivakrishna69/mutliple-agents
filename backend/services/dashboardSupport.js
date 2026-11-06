/**
 * The dashboard's support section (admins and support agents), measured from the conversations
 * and their messages. Nothing is estimated: a figure with nothing to measure is null.
 *
 *   queue      conversations now: waiting for an agent (escalated, unclaimed), assigned to the
 *              viewer, with any agent, with the AI; and how many are in each status
 *   period     over the conversations opened in the range (and the same stretch before, for the
 *              change):
 *                handledByAiShare    no agent ever replied and none owns it: the AI handled it
 *                escalationShare     an agent replied or owns it
 *                avgFirstResponseMs  first customer message -> first reply (AI or agent), averaged
 *                withinTargetShare   first replies within DASHBOARD_SETTINGS.FIRST_RESPONSE_TARGET_MS
 *                medianAiReplyMs     first customer message -> the AI's first reply, the median
 *   activity   AI and agent replies per local hour (today) or day (longer ranges)
 *   recent     the newest conversations the viewer may see (services/conversationAccess.js)
 *
 * AI messages are those written by the AI service (ai_supervisor, ai_worker); agent messages are
 * human_agent. Shares are fractions 0..1; durations are whole milliseconds.
 */

import { DASHBOARD_SETTINGS } from '../constants/validation.js';
import Conversation, { CONVERSATION_STATUS, HUMAN_OWNED_STATUSES } from '../models/Conversation.js';
import Message, { SENDER_TYPE } from '../models/Message.js';
import User from '../models/User.js';
import { buildVisibleConversationFilter } from './conversationAccess.js';
import { chartBucketsOf } from './dashboardRange.js';

const AI_SENDERS = Object.freeze([SENDER_TYPE.AI_SUPERVISOR, SENDER_TYPE.AI_WORKER]);
const SNIPPET_LENGTH = 160;

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);
const average = (values) =>
  values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

/** The queue as it is now. */
async function loadQueue(viewer) {
  const byStatus = await Conversation.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const statusCounts = Object.fromEntries(Object.values(CONVERSATION_STATUS).map((status) => [status, 0]));
  for (const { _id: status, count } of byStatus) statusCounts[status] = count;
  const assignedToYou = await Conversation.countDocuments({
    status: CONVERSATION_STATUS.ASSIGNED_AGENT,
    assignedAgentId: viewer.id,
  });
  return {
    waitingForAgent: await Conversation.countDocuments({
      status: CONVERSATION_STATUS.ESCALATED_TO_HUMAN,
      assignedAgentId: null,
    }),
    assignedToYou,
    withAgents: statusCounts[CONVERSATION_STATUS.ASSIGNED_AGENT],
    withAi: statusCounts[CONVERSATION_STATUS.PROCESSING_AI],
    statusCounts,
  };
}

/** The figures over the conversations opened in [from, to). */
export async function measureSupportPeriod(from, to) {
  const conversations = await Conversation.find({ createdAt: { $gte: from, $lt: to } })
    .select('_id status')
    .lean();
  const empty = {
    conversations: 0,
    handledByAiShare: null,
    escalationShare: null,
    avgFirstResponseMs: null,
    withinTargetShare: null,
    medianAiReplyMs: null,
  };
  if (conversations.length === 0) return empty;

  const firsts = await Message.aggregate([
    { $match: { conversationId: { $in: conversations.map((conversation) => conversation._id) } } },
    {
      $group: {
        _id: '$conversationId',
        firstCustomerAt: { $min: { $cond: [{ $eq: ['$senderType', SENDER_TYPE.CUSTOMER] }, '$createdAt', null] } },
        firstAiAt: { $min: { $cond: [{ $in: ['$senderType', AI_SENDERS] }, '$createdAt', null] } },
        firstAgentAt: { $min: { $cond: [{ $eq: ['$senderType', SENDER_TYPE.HUMAN_AGENT] }, '$createdAt', null] } },
      },
    },
  ]);
  const firstsById = new Map(firsts.map((row) => [row._id.toString(), row]));

  let handledByAi = 0;
  let neededAgent = 0;
  const firstResponses = [];
  const aiReplies = [];
  for (const conversation of conversations) {
    const {
      firstCustomerAt = null,
      firstAiAt = null,
      firstAgentAt = null,
    } = firstsById.get(conversation._id.toString()) ?? {};
    const humanInvolved = Boolean(firstAgentAt) || HUMAN_OWNED_STATUSES.includes(conversation.status);
    if (humanInvolved) neededAgent += 1;
    else if (firstAiAt) handledByAi += 1;
    if (!firstCustomerAt) continue;
    const replies = [firstAiAt, firstAgentAt].filter((at) => at && at >= firstCustomerAt);
    if (replies.length > 0) firstResponses.push(Math.min(...replies.map(Number)) - firstCustomerAt.getTime());
    if (firstAiAt && firstAiAt >= firstCustomerAt) aiReplies.push(firstAiAt.getTime() - firstCustomerAt.getTime());
  }

  return {
    conversations: conversations.length,
    handledByAiShare: share(handledByAi, conversations.length),
    escalationShare: share(neededAgent, conversations.length),
    avgFirstResponseMs: average(firstResponses),
    withinTargetShare: share(
      firstResponses.filter((waitMs) => waitMs <= DASHBOARD_SETTINGS.FIRST_RESPONSE_TARGET_MS).length,
      firstResponses.length,
    ),
    medianAiReplyMs: median(aiReplies),
  };
}

/** Each figure's change from the previous period; null when either side has nothing to measure. */
function changeBetween(current, previous) {
  const difference = (key) => (current[key] === null || previous[key] === null ? null : current[key] - previous[key]);
  const shareChange = difference('handledByAiShare');
  return {
    conversations: current.conversations - previous.conversations,
    // Rounded like the shares themselves, so 0.1 - 0.3 reads -0.2, not -0.19999999999999998.
    handledByAiShare: shareChange === null ? null : Math.round(shareChange * 1000) / 1000,
    avgFirstResponseMs: difference('avgFirstResponseMs'),
    medianAiReplyMs: difference('medianAiReplyMs'),
  };
}

/** AI and agent replies per bucket of the range, in its time zone. */
async function loadActivity(range) {
  const { unit, format, buckets } = chartBucketsOf(range);
  const rows = await Message.aggregate([
    {
      $match: {
        createdAt: { $gte: range.start, $lt: range.end },
        senderType: { $in: [...AI_SENDERS, SENDER_TYPE.HUMAN_AGENT] },
      },
    },
    {
      $group: {
        _id: {
          bucket: { $dateToString: { format, date: '$createdAt', timezone: range.timeZone } },
          byAgent: { $eq: ['$senderType', SENDER_TYPE.HUMAN_AGENT] },
        },
        count: { $sum: 1 },
      },
    },
  ]);
  const counts = new Map();
  for (const { _id: key, count } of rows) {
    const bucket = counts.get(key.bucket) ?? { ai: 0, agent: 0 };
    bucket[key.byAgent ? 'agent' : 'ai'] += count;
    counts.set(key.bucket, bucket);
  }
  return {
    unit,
    points: buckets.map(({ key, label }) => ({ key, label, ...(counts.get(key) ?? { ai: 0, agent: 0 }) })),
  };
}

/** The newest conversations the viewer may see, with who wrote last and what. */
async function loadRecent(viewer) {
  const conversations = await Conversation.find(buildVisibleConversationFilter(viewer))
    .sort({ updatedAt: -1 })
    .limit(DASHBOARD_SETTINGS.RECENT_CONVERSATIONS)
    .select('_id customerId assignedAgentId status updatedAt')
    .lean();
  const ids = conversations.map((conversation) => conversation._id);
  const [customers, lastMessages] = await Promise.all([
    User.find({ _id: { $in: conversations.map((conversation) => conversation.customerId) } })
      .select('name')
      .lean(),
    Message.aggregate([
      { $match: { conversationId: { $in: ids } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$conversationId',
          senderType: { $first: '$senderType' },
          text: { $first: '$text' },
          at: { $first: '$createdAt' },
        },
      },
    ]),
  ]);
  const customerNames = new Map(customers.map((customer) => [customer._id.toString(), customer.name]));
  const lastById = new Map(lastMessages.map((message) => [message._id.toString(), message]));
  return conversations.map((conversation) => {
    const last = lastById.get(conversation._id.toString());
    return {
      id: conversation._id.toString(),
      status: conversation.status,
      customerName: customerNames.get(conversation.customerId?.toString()) ?? null,
      assignedToYou: conversation.assignedAgentId?.toString() === viewer.id,
      updatedAt: conversation.updatedAt.toISOString(),
      lastMessage: last
        ? { senderType: last.senderType, text: last.text.slice(0, SNIPPET_LENGTH), at: last.at.toISOString() }
        : null,
    };
  });
}

/**
 * @param {{ viewer: { id: string, role: string }, range: object }} request  range: services/dashboardRange.js
 */
export async function loadSupportSummary({ viewer, range }) {
  const [queue, current, previous, activity, recent] = await Promise.all([
    loadQueue(viewer),
    measureSupportPeriod(range.start, range.end),
    measureSupportPeriod(range.previousStart, range.previousEnd),
    loadActivity(range),
    loadRecent(viewer),
  ]);
  return {
    queue,
    period: { ...current, firstResponseTargetMs: DASHBOARD_SETTINGS.FIRST_RESPONSE_TARGET_MS },
    change: changeBetween(current, previous),
    activity,
    recent,
  };
}
