/**
 * GET /api/dashboard/overview?range=today|7d|30d   the signed-in person's dashboard, in sections
 *                                                  their role may see (services/dashboardOverview.js)
 *
 * The range defaults to today; anything else is a 400 with the server's message under `range`.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';
import { DASHBOARD_MESSAGES } from '../constants/messages.js';
import { DASHBOARD_SETTINGS } from '../constants/validation.js';
import { buildDashboardOverview } from '../services/dashboardOverview.js';
import { isDashboardRange } from '../services/dashboardRange.js';
import { sendError, sendSuccess } from '../utils/apiResponse.js';

export async function getDashboardOverview(req, res, next) {
  try {
    const rangeKey = req.query.range ?? DASHBOARD_SETTINGS.RANGES.TODAY;
    if (!isDashboardRange(rangeKey)) {
      return sendError(req, res, HTTP_STATUS.BAD_REQUEST, DASHBOARD_MESSAGES.RANGE_INVALID, [
        { field: 'range', message: DASHBOARD_MESSAGES.RANGE_INVALID },
      ]);
    }
    const overview = await buildDashboardOverview({ viewer: { id: req.user.id, role: req.user.role }, rangeKey });
    return sendSuccess(res, HTTP_STATUS.OK, DASHBOARD_MESSAGES.OVERVIEW_RETRIEVED, overview);
  } catch (error) {
    return next(error);
  }
}
