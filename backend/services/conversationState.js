/**
 * Shared write path for conversation state and messages, used by every caller that changes them
 * (the webhook pipeline and the staff conversation routes), so all changes are made and published
 * the same way.
 *
 *   updateConversationWithRetry  load -> apply change -> save, retrying on optimistic-concurrency
 *                                conflicts (Conversation has optimisticConcurrency enabled), then
 *                                publish CONVERSATION_STATUS_UPDATED.
 *   publishMessage               publish NEW_MESSAGE for a message that has been saved.
 *   publishConversationState     publish CONVERSATION_STATUS_UPDATED for a saved conversation.
 *   touchConversation            bump updatedAt after a message that did not change state, and
 *                                publish it, so activity-sorted lists stay current.
 *
 * Publishing always happens after the write is committed, so subscribers never see an event for
 * data that is not in the database. The socket helpers never throw, so a real-time problem can
 * never fail the write that triggered it.
 */

import mongoose from 'mongoose';
import Conversation from '../models/Conversation.js';
import { toStaffConversationStatusPayload, toStaffMessagePayload } from '../utils/realtimePayloads.js';
import { emitConversationStatusUpdate, emitNewMessage } from '../utils/socketManager.js';

/** Attempts for a state update that loses an optimistic-concurrency race. */
const MAX_STATE_UPDATE_ATTEMPTS = 3;

export function publishMessage(messageRecord) {
  emitNewMessage(messageRecord.conversationId, toStaffMessagePayload(messageRecord));
}

/** Awaited by callers so consecutive changes to one conversation reach clients in write order. */
export async function publishConversationState(conversationRecord) {
  await emitConversationStatusUpdate(conversationRecord._id, toStaffConversationStatusPayload(conversationRecord));
}

/**
 * Marks a conversation as active now (updatedAt) after a message was added without a state change,
 * so lists sorted by recent activity stay correct, and publishes the refreshed status payload so
 * open consoles re-sort live. Only `updatedAt` is written, which the Conversation model's guard on
 * workflow fields permits for query updates.
 */
export async function touchConversation(conversationId) {
  const touchedConversation = await Conversation.findOneAndUpdate(
    { _id: conversationId },
    { $currentDate: { updatedAt: true } },
    { new: true, timestamps: false },
  ).lean();
  if (touchedConversation) await publishConversationState(touchedConversation);
  return touchedConversation;
}

/**
 * Loads a conversation, lets `applyChange` modify it, and saves it, reloading and retrying if
 * another writer saved first (VersionError). `applyChange` returns false when the current state
 * needs no change, in which case nothing is written or published.
 * Returns the conversation as stored after the update, or null if it does not exist.
 * @param {import('mongoose').Types.ObjectId|string} conversationId
 * @param {(conversationRecord: import('mongoose').Document) => boolean} applyChange
 */
export async function updateConversationWithRetry(conversationId, applyChange) {
  for (let attemptNumber = 1; attemptNumber <= MAX_STATE_UPDATE_ATTEMPTS; attemptNumber += 1) {
    const conversationRecord = await Conversation.findById(conversationId);
    if (!conversationRecord) return null;
    if (!applyChange(conversationRecord)) return conversationRecord;
    try {
      await conversationRecord.save();
      await publishConversationState(conversationRecord);
      return conversationRecord;
    } catch (saveError) {
      const isLastAttempt = attemptNumber === MAX_STATE_UPDATE_ATTEMPTS;
      if (!(saveError instanceof mongoose.Error.VersionError) || isLastAttempt) throw saveError;
    }
  }
  return null;
}
