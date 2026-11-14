/**
 * The NSK assistant's sessions and turns (routes/nskBotRoutes.js). Everything here is the signed-in
 * person's own: their sessions, their messages, the tools acting for them.
 *
 *   listSessions(user)        their sessions, newest first, and `resume`: the latest one when they
 *                             come back within NSK_BOT_SETTINGS.RESUME_WINDOW_HOURS, with its topics
 *                             and the suggestions its last answer made (offered as starter chips)
 *   getSession(user, id)      one session with its messages
 *   deleteSession(user, id)   a session and its messages (and its cached context)
 *   sendMessage(user, input)  one turn:
 *     1. the daily quota (NSK_DAILY_MESSAGE_LIMIT, a UTC day) and the session (new or continued)
 *     2. the context: the session's recent messages (cached in Redis, NSK_BOT_SETTINGS
 *        .CONTEXT_CACHE_TTL_SECONDS; MongoDB when the cache misses) and the memory of earlier
 *        sessions (the most recent, and those whose title, topics or names match the message)
 *     3. the ai-service turn (nskTurnClient.js) with the intents and tools this person may use and a
 *        fresh actor token (actorToken.js); the tools check the person again on every call
 *     4. the reply's sources are checked: a document must belong to a knowledge base the person may
 *        read, a session must be one of the memories sent; anything else is dropped. Suggestions
 *        outside the person's intents are dropped.
 *     5. both messages are stored, the session remembers the turn's topic and names, and the cached
 *        context is updated
 *   When the ai-service fails, nothing of the turn is kept and the quota is given back.
 */

import { ROLE_DEFINITIONS } from '../../constants/accessRoles.js';
import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { NSK_BOT_MESSAGES } from '../../constants/messages.js';
import {
  NSK_ESCALATING_SENTIMENTS,
  NSK_MESSAGE_ROLES,
  NSK_SOURCE_KINDS,
  allowedIntentsFor,
} from '../../constants/nskBot.js';
import { NSK_BOT_SETTINGS } from '../../constants/validation.js';
import AgentDocument from '../../models/AgentDocument.js';
import ChatMessage from '../../models/ChatMessage.js';
import ChatSession from '../../models/ChatSession.js';
import EmployeeProfile from '../../models/EmployeeProfile.js';
import NskBotUsage from '../../models/NskBotUsage.js';
import { logger } from '../../utils/logger.js';
import { readOfficeLocalClock } from '../attendancePolicy.js';
import { deleteCachedJson, getCachedJson, setCachedJson } from '../cacheStore.js';
import { getCompanySettings } from '../companySettings.js';
import { reserveDailyUsage } from '../dailyUsageQuota.js';
import { loadEmployeeLeaveContext } from '../leaveSettings.js';
import { ServiceError } from '../serviceError.js';
import { issueActorToken } from './actorToken.js';
import { readableKnowledgeDepartments, toolsAvailableTo } from './nskTools.js';
import { requestNskTurn } from './nskTurnClient.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const S = NSK_BOT_SETTINGS;
const API_ROLES = Object.freeze({ [NSK_MESSAGE_ROLES.USER]: 'user', [NSK_MESSAGE_ROLES.ASSISTANT]: 'assistant' });

const refusal = (httpStatus, code) => new ServiceError(httpStatus, code, NSK_BOT_MESSAGES[code]);
const retentionFrom = (date) => new Date(date.getTime() + S.RETENTION_DAYS * DAY_MS);
const contextKey = (sessionId) => `nsk:context:${sessionId}`;
const calendarDateOf = (instant) => instant.toISOString().slice(0, 10);
const roleLabelOf = (role) => ROLE_DEFINITIONS.find((definition) => definition.value === role)?.label ?? role;

const titleOf = (message) => {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= S.TITLE_MAX_LENGTH ? flat : `${flat.slice(0, S.TITLE_MAX_LENGTH - 1).trimEnd()}…`;
};

// =================================================================================================
// Summaries
// =================================================================================================

export function toSessionSummary(session) {
  return {
    id: session._id.toString(),
    title: session.title,
    topics: session.topics ?? [],
    lastIntent: session.lastIntent ?? null,
    messageCount: session.messageCount ?? 0,
    lastMessageAt: session.lastMessageAt,
    createdAt: session.createdAt,
  };
}

function toCitationSummary(citation) {
  return {
    number: citation.number,
    kind: citation.kind,
    label: citation.label,
    tool: citation.tool ?? null,
    documentId: citation.documentId?.toString() ?? null,
    departmentId: citation.departmentId?.toString() ?? null,
    headingPath: citation.headingPath ?? [],
    page: citation.page ?? null,
    sessionId: citation.sessionId?.toString() ?? null,
    excerpt: citation.excerpt ?? null,
  };
}

export function toMessageSummary(message) {
  const isAssistant = message.role === NSK_MESSAGE_ROLES.ASSISTANT;
  return {
    id: message._id.toString(),
    role: message.role,
    content: message.content,
    outcome: message.outcome ?? null,
    classification: message.classification
      ? {
          intent: message.classification.intent,
          sentiment: message.classification.sentiment,
          confidence: message.classification.confidence,
          entities: message.classification.entities ?? [],
        }
      : null,
    citations: (message.citations ?? []).map(toCitationSummary),
    suggestions: (message.suggestions ?? []).map(({ text, intent }) => ({ text, intent })),
    escalation: isAssistant && message.escalation ? { hint: NSK_BOT_MESSAGES.ESCALATION_HINT } : null,
    createdAt: message.createdAt,
  };
}

// =================================================================================================
// Sessions
// =================================================================================================

async function findOwnSession(user, sessionId) {
  const session = await ChatSession.findOne({ _id: sessionId, userId: user.id }).lean();
  if (!session) throw refusal(HTTP_STATUS.NOT_FOUND, 'SESSION_NOT_FOUND');
  return session;
}

/** The latest session, offered to resume when it is recent enough; null otherwise. */
export function resumeOffer(latest, now = new Date()) {
  if (!latest || now.getTime() - latest.lastMessageAt.getTime() > S.RESUME_WINDOW_HOURS * HOUR_MS) return null;
  const continueChip = { text: NSK_BOT_MESSAGES.RESUME_CONTINUE(latest.title), intent: latest.lastIntent };
  return {
    session: toSessionSummary(latest),
    prompt: NSK_BOT_MESSAGES.RESUME_PROMPT(latest.title),
    suggestions: [
      ...(latest.lastIntent ? [continueChip] : []),
      ...(latest.lastSuggestions ?? []).map(({ text, intent }) => ({ text, intent })),
    ].slice(0, S.SUGGESTIONS_MAX),
  };
}

export async function listSessions(user, { now = new Date() } = {}) {
  const sessions = await ChatSession.find({ userId: user.id })
    .sort({ lastMessageAt: -1 })
    .limit(S.SESSIONS_LISTED)
    .lean();
  return { sessions: sessions.map(toSessionSummary), resume: resumeOffer(sessions[0] ?? null, now) };
}

export async function getSession(user, sessionId) {
  const session = await findOwnSession(user, sessionId);
  const messages = await ChatMessage.find({ sessionId: session._id })
    .sort({ createdAt: 1, _id: 1 })
    .limit(S.MESSAGES_PER_SESSION_LISTED)
    .lean();
  return { session: toSessionSummary(session), messages: messages.map(toMessageSummary) };
}

export async function deleteSession(user, sessionId) {
  const session = await findOwnSession(user, sessionId);
  const { deletedCount } = await ChatMessage.deleteMany({ sessionId: session._id });
  await ChatSession.deleteOne({ _id: session._id });
  await deleteCachedJson(contextKey(session._id));
  return { deletedMessages: deletedCount };
}

// =================================================================================================
// A turn's context
// =================================================================================================

/** The session's recent messages for the model, oldest first: the cache, or MongoDB on a miss. */
async function recentHistory(sessionId) {
  const cached = await getCachedJson(contextKey(sessionId));
  if (Array.isArray(cached?.history)) return cached.history;
  const messages = await ChatMessage.find({ sessionId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(S.HISTORY_MESSAGES)
    .select('role content')
    .lean();
  return messages.reverse().map((message) => ({ role: API_ROLES[message.role], content: message.content }));
}

/**
 * Earlier sessions to remember: those matching the message's words first (the text index), then the
 * most recent, at most NSK_BOT_SETTINGS.MEMORY_SESSIONS, never the current one.
 */
async function memorySessions(user, message, currentSessionId) {
  const others = { userId: user.id, ...(currentSessionId ? { _id: { $ne: currentSessionId } } : {}) };
  let matching = [];
  try {
    matching = await ChatSession.find({ ...others, $text: { $search: message } }, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(S.MEMORY_SESSIONS)
      .lean();
  } catch (searchError) {
    // Without the text index (still building) the recent sessions are enough.
    logger.warn('NSK memory search failed; using recent sessions only', { error: searchError.message });
  }
  const recent = await ChatSession.find(others).sort({ lastMessageAt: -1 }).limit(S.MEMORY_SESSIONS).lean();
  const unique = new Map();
  for (const session of [...matching, ...recent]) {
    if (!unique.has(session._id.toString())) unique.set(session._id.toString(), session);
  }
  return [...unique.values()].slice(0, S.MEMORY_SESSIONS);
}

/** The person's own day: their office's time zone, or the company's without an employee record. */
async function personalDay(userId, now) {
  const profile = await EmployeeProfile.findOne({ userId }).select('_id').lean();
  if (profile) {
    const { today, timeZone } = await loadEmployeeLeaveContext(profile._id, { now });
    return { today, timeZone };
  }
  const { timeZone } = await getCompanySettings();
  return { today: readOfficeLocalClock(now, timeZone).calendarDate, timeZone };
}

// =================================================================================================
// Checking what the reply cites
// =================================================================================================

/**
 * The reply's sources as citations to store: documents the person may read (named), sessions among
 * the memories sent, tool reads as labelled by the tools. Anything else is dropped and logged.
 */
async function checkedCitations(user, sources, memories) {
  const documentSources = sources.filter((source) => source.kind === NSK_SOURCE_KINDS.DOCUMENT);
  const readable = documentSources.length ? new Set((await readableKnowledgeDepartments(user)).map((d) => d.id)) : null;
  const documents = documentSources.length
    ? await AgentDocument.find({ _id: { $in: documentSources.map((source) => source.documentId) } })
        .select('departmentId originalName')
        .lean()
    : [];
  const documentById = new Map(documents.map((document) => [document._id.toString(), document]));
  const memoryById = new Map(memories.map((session) => [session._id.toString(), session]));

  const citations = [];
  let dropped = 0;
  for (const source of sources) {
    if (source.kind === NSK_SOURCE_KINDS.TOOL) {
      citations.push({ number: source.number, kind: source.kind, label: source.label, tool: source.tool });
    } else if (source.kind === NSK_SOURCE_KINDS.CONVERSATION) {
      const session = memoryById.get(source.sessionId);
      if (!session) {
        dropped += 1;
        continue;
      }
      citations.push({
        number: source.number,
        kind: source.kind,
        label: NSK_BOT_MESSAGES.SOURCE_LABELS.CONVERSATION(session.title, calendarDateOf(session.lastMessageAt)),
        sessionId: session._id,
      });
    } else {
      const document = documentById.get(source.documentId);
      const departmentId = document?.departmentId.toString();
      if (!document || departmentId !== source.departmentId || !readable.has(departmentId)) {
        dropped += 1;
        continue;
      }
      const name = document.originalName ?? NSK_BOT_MESSAGES.SOURCE_LABELS.DOCUMENT_UNNAMED;
      citations.push({
        number: source.number,
        kind: source.kind,
        label: NSK_BOT_MESSAGES.SOURCE_LABELS.DOCUMENT(name, source.page),
        documentId: document._id,
        documentName: name,
        departmentId: document.departmentId,
        headingPath: source.headingPath,
        page: source.page,
        excerpt: source.excerpt,
      });
    }
  }
  if (dropped) logger.warn('NSK reply cited sources the person may not read; dropped them', { dropped });
  return citations;
}

/** What the session remembers after a turn: the topic and names, newest last, deduplicated. */
function rememberedAfter(session, classification) {
  const topics = [...(session?.topics ?? [])];
  if (classification.topic) {
    const index = topics.findIndex((topic) => topic.toLowerCase() === classification.topic.toLowerCase());
    if (index !== -1) topics.splice(index, 1);
    topics.push(classification.topic);
  }
  const entities = [...(session?.entities ?? [])].map(({ kind, value }) => ({ kind, value }));
  for (const entity of classification.entities) {
    const index = entities.findIndex(
      (known) => known.kind === entity.kind && known.value.toLowerCase() === entity.value.toLowerCase(),
    );
    if (index !== -1) entities.splice(index, 1);
    entities.push(entity);
  }
  return { topics: topics.slice(-S.TOPICS_KEPT), entities: entities.slice(-S.ENTITIES_KEPT) };
}

// =================================================================================================
// A turn
// =================================================================================================

/**
 * @param {{ id: string, name: string, role: string }} user
 * @param {{ message: string, sessionId: string|null }} input
 * @param {{ config: object, requestId: string, now?: Date }} context
 * @returns {Promise<{ session, userMessage, message, outcome, classification, toolsUsed, durationMs }>}
 */
export async function sendMessage(user, { message, sessionId }, { config, requestId, now = new Date() }) {
  const existing = sessionId ? await findOwnSession(user, sessionId) : null;
  const quota = await reserveDailyUsage({
    usageModel: NskBotUsage,
    userId: user.id,
    limit: config.nskDailyMessageLimit,
    retentionDays: S.USAGE_RETENTION_DAYS,
    limitError: () =>
      new ServiceError(
        HTTP_STATUS.TOO_MANY_REQUESTS,
        'DAILY_LIMIT_REACHED',
        NSK_BOT_MESSAGES.DAILY_LIMIT_REACHED(config.nskDailyMessageLimit),
      ),
  });

  const [history, memories, day] = await Promise.all([
    existing ? recentHistory(existing._id) : [],
    memorySessions(user, message, existing?._id ?? null),
    personalDay(user.id, now),
  ]);
  const session =
    existing ??
    (
      await ChatSession.create({
        userId: user.id,
        title: titleOf(message),
        lastMessageAt: now,
        expiresAt: retentionFrom(now),
      })
    ).toObject();
  const userMessage = (
    await ChatMessage.create({
      sessionId: session._id,
      userId: user.id,
      role: NSK_MESSAGE_ROLES.USER,
      content: message,
      expiresAt: retentionFrom(now),
    })
  ).toObject();

  const allowedIntents = allowedIntentsFor(user.role);
  let turn;
  try {
    turn = await requestNskTurn(
      {
        actor_token: issueActorToken({
          key: config.nskActorTokenKey,
          userId: user.id,
          sessionId: session._id,
          ttlSeconds: S.ACTOR_TOKEN_TTL_SECONDS,
          now,
        }),
        user: { name: user.name, role_label: roleLabelOf(user.role) },
        today: day.today,
        time_zone: day.timeZone,
        message,
        history,
        memory: memories.map((memory) => ({
          session_id: memory._id.toString(),
          title: memory.title,
          date: calendarDateOf(memory.lastMessageAt),
          topics: memory.topics ?? [],
          entities: (memory.entities ?? []).map(({ kind, value }) => ({ kind, value })),
        })),
        allowed_intents: allowedIntents,
        allowed_tools: toolsAvailableTo(user.role),
      },
      { config, requestId },
    );
  } catch (turnError) {
    // Nothing of an unanswered turn is kept: the person can simply send it again.
    await ChatMessage.deleteOne({ _id: userMessage._id });
    if (!existing) await ChatSession.deleteOne({ _id: session._id });
    await quota.giveBack();
    throw turnError;
  }

  const answeredAt = new Date(Math.max(Date.now(), now.getTime() + 1));
  const { classification } = turn;
  const suggestions = turn.suggestions.filter((suggestion) => allowedIntents.includes(suggestion.intent));
  const assistantMessage = (
    await ChatMessage.create({
      sessionId: session._id,
      userId: user.id,
      role: NSK_MESSAGE_ROLES.ASSISTANT,
      content: turn.reply,
      outcome: turn.outcome,
      citations: await checkedCitations(user, turn.sources, memories),
      suggestions,
      escalation: NSK_ESCALATING_SENTIMENTS.includes(classification.sentiment),
      toolsUsed: turn.toolsUsed,
      usage: turn.usage ?? { inputTokens: null, outputTokens: null },
      expiresAt: retentionFrom(answeredAt),
    })
  ).toObject();
  await ChatMessage.updateOne(
    { _id: userMessage._id },
    {
      $set: {
        classification: {
          intent: classification.intent,
          sentiment: classification.sentiment,
          confidence: classification.confidence,
          entities: classification.entities,
        },
      },
    },
  );
  const remembered = rememberedAfter(existing, classification);
  const updatedSession = await ChatSession.findOneAndUpdate(
    { _id: session._id },
    {
      $set: {
        ...remembered,
        lastIntent: classification.intent,
        lastSuggestions: suggestions,
        lastMessageAt: answeredAt,
        expiresAt: retentionFrom(answeredAt),
      },
      $inc: { messageCount: 2 },
    },
    { new: true },
  ).lean();
  await setCachedJson(
    contextKey(session._id),
    {
      history: [
        ...history,
        { role: API_ROLES[NSK_MESSAGE_ROLES.USER], content: message },
        { role: API_ROLES[NSK_MESSAGE_ROLES.ASSISTANT], content: turn.reply },
      ].slice(-S.HISTORY_MESSAGES),
    },
    S.CONTEXT_CACHE_TTL_SECONDS,
  );
  await quota.recordTokens(turn.usage);

  return {
    session: toSessionSummary(updatedSession),
    userMessage: toMessageSummary({ ...userMessage, classification }),
    message: toMessageSummary(assistantMessage),
    outcome: turn.outcome,
    classification,
    toolsUsed: turn.toolsUsed,
    durationMs: turn.durationMs,
  };
}
