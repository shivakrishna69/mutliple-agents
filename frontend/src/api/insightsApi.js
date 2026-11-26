/**
 * The daily briefing (backend/controllers/insightsController.js):
 *   GET /api/insights/daily-briefing   what needs the signed-in person today, as cards, with a
 *                                      headline, counts and exact queue counts (never cached by the
 *                                      browser; the backend caches it per person and clears it on
 *                                      every change it covers, then sends INSIGHTS_CHANGED)
 * Returns the response's `data.briefing`; failures throw ApiError (api/httpClient.js).
 */

import { sendApiRequest } from './httpClient.js';

export async function requestDailyBriefing(callerSignal) {
  const { responseData } = await sendApiRequest({
    method: 'GET',
    endpointPath: '/api/insights/daily-briefing',
    callerSignal,
  });
  return responseData.briefing;
}
