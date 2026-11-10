/**
 * Notification: something a person should know about in the app (the bell), also pushed to their
 * open sessions as it happens (SOCKET_EVENTS.NOTIFICATION_CREATED). Generic on purpose: `type` says
 * what happened, `link` where in the app to look, `data` the ids the page needs.
 *
 *   type     NOTIFICATION_TYPES
 *   title    short, already in the reader's words (constants/messages.js NOTIFICATION_MESSAGES)
 *   body     one sentence
 *   link     an app path, e.g. "/knowledge/<departmentId>?question=<id>", or null
 *   readAt   when they opened it, or null
 *   expiresAt  createdAt + NOTIFICATION_SETTINGS.RETENTION_DAYS (TTL)
 */

import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const NOTIFICATION_TYPES = Object.freeze({
  // To a department's head and knowledge lead: a question is waiting in their Questions Inbox.
  AGENT_QUESTION_RECEIVED: 'AGENT_QUESTION_RECEIVED',
  // To the person who asked: the department answered their question.
  AGENT_QUESTION_ANSWERED: 'AGENT_QUESTION_ANSWERED',
});

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, immutable: true },
    type: { type: String, enum: Object.values(NOTIFICATION_TYPES), required: true, immutable: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 500 },
    link: { type: String, default: null, maxlength: 300 },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// A person's notifications, newest first, and the unread count.
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('Notification', notificationSchema);
