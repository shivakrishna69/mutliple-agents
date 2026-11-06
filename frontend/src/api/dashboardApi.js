/**
 * The dashboard (backend/routes/dashboardRoutes.js) and the services' health
 * (backend/routes/systemRoutes.js). Failures reject with ApiError carrying the server's message.
 */

import { API_MESSAGES } from '../constants/messages.js';
import { ApiError, sendApiRequest } from './httpClient.js';

const OVERVIEW_PATH = '/api/dashboard/overview';
const SYSTEM_HEALTH_PATH = '/api/system/health';

/**
 * The signed-in person's dashboard for a range ("today", "7d", "30d"): `range`, `ranges`, and the
 * sections their role may see (`people`, `support`, `accounts`, `me`; null when not theirs).
 */
export async function requestDashboardOverview(rangeKey, { signal } = {}) {
  const { responseData, httpStatus } = await sendApiRequest({
    method: 'GET',
    endpointPath: `${OVERVIEW_PATH}?range=${encodeURIComponent(rangeKey)}`,
    callerSignal: signal,
  });
  if (!responseData?.range || !Array.isArray(responseData.ranges)) {
    throw new ApiError({ message: API_MESSAGES.UNEXPECTED_RESPONSE, status: httpStatus });
  }
  return responseData;
}

/** The AI service, email, database and cache: `{ overall, overallLabel, checkedAt, services }`. Admins only. */
export async function requestSystemHealth({ signal } = {}) {
  const { responseData, httpStatus } = await sendApiRequest({
    method: 'GET',
    endpointPath: SYSTEM_HEALTH_PATH,
    callerSignal: signal,
  });
  if (!Array.isArray(responseData?.services)) {
    throw new ApiError({ message: API_MESSAGES.UNEXPECTED_RESPONSE, status: httpStatus });
  }
  return responseData;
}
