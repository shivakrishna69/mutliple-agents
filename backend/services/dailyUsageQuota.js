/**
 * A daily question quota per person, counted in a usage collection (models/dailyChatUsageSchema.js)
 * over the UTC day. Used by the department agents and the NSK assistant, each with its own
 * collection and limit.
 *
 *   reserveDailyUsage(...)   counts one question for today, or refuses (the given ServiceError)
 *                            past the limit without counting it. Returns
 *                              giveBack()             uncounts it (the question was not answered)
 *                              recordTokens(usage)    adds the model tokens it used
 */

import { isDuplicateKeyError } from '../utils/mongoErrors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);

/**
 * @param {{ usageModel: import('mongoose').Model, userId: string, limit: number, retentionDays: number,
 *   limitError: () => Error }} options
 * @returns {Promise<{ giveBack: () => Promise<unknown>,
 *   recordTokens: (usage: { inputTokens: number, outputTokens: number }|null) => Promise<unknown>|null }>}
 */
export async function reserveDailyUsage({ usageModel, userId, limit, retentionDays, limitError }) {
  const day = utcDay();
  const increment = () =>
    usageModel
      .findOneAndUpdate(
        { userId, day },
        {
          $inc: { questions: 1 },
          $setOnInsert: { expiresAt: new Date(Date.now() + (retentionDays + 1) * DAY_MS) },
        },
        { upsert: true, new: true },
      )
      .lean();
  let usage;
  try {
    usage = await increment();
  } catch (incrementError) {
    // Two first questions of the day at once: the second upsert finds the first one's counter.
    if (!isDuplicateKeyError(incrementError)) throw incrementError;
    usage = await increment();
  }
  const giveBack = () => usageModel.updateOne({ userId, day }, { $inc: { questions: -1 } });
  if (usage.questions > limit) {
    await giveBack();
    throw limitError();
  }
  return {
    giveBack,
    recordTokens: (usageReport) =>
      usageReport
        ? usageModel.updateOne(
            { userId, day },
            { $inc: { inputTokens: usageReport.inputTokens, outputTokens: usageReport.outputTokens } },
          )
        : null,
  };
}
