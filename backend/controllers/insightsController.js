/**
 * The daily briefing (services/insights/dailyBriefing.js), mounted at /api/insights:
 *
 *   GET /daily-briefing   this person's cards for today: leave to approve, task revisions, what is up
 *                         next, overdue and due-today work, reviews waiting on them, and their team's
 *                         operational counts; each card with its actions
 *
 * Every signed-in person may ask; what they get follows their capabilities, the boards they work on
 * and the people who report to them. Cached for INSIGHT_SETTINGS.CACHE_TTL_SECONDS per person.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { INSIGHT_MESSAGES } from '../constants/messages.js';
import { getDailyBriefing } from '../services/insights/dailyBriefing.js';
import { sendSuccess } from '../utils/apiResponse.js';

/** GET /api/insights/daily-briefing */
export async function getBriefing(req, res, next) {
  try {
    const briefing = await getDailyBriefing({ id: req.user.id, role: req.user.role });
    return sendSuccess(res, HTTP_STATUS.OK, INSIGHT_MESSAGES.BRIEFING_RETRIEVED, { briefing });
  } catch (error) {
    return next(error);
  }
}
