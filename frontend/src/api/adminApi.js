/**
 * Admin endpoints (backend/routes/adminRoutes.js): user listing and role management.
 * The backend allows these for admins only; failures reject with ApiError.
 */

import { API_MESSAGES } from '../constants/messages.js';
import { ApiError, sendApiRequest } from './httpClient.js';

const ADMIN_USERS_PATH = '/api/admin/users';

/**
 * Users matching an optional name/email search and role filter, newest first (max 200),
 * plus the total number of accounts per role.
 * @param {{ search?: string, role?: string }} filters
 * @returns {Promise<{ users: Array<{ id, name, email, role, createdAt }>, countsByRole: Record<string, number> }>}
 */
export async function requestUserList({ search = '', role = '' } = {}, { signal } = {}) {
  const queryParameters = new URLSearchParams();
  if (search.trim()) queryParameters.set('search', search.trim());
  if (role) queryParameters.set('role', role);
  const queryString = queryParameters.toString();

  const { responseData, httpStatus } = await sendApiRequest({
    method: 'GET',
    endpointPath: queryString ? `${ADMIN_USERS_PATH}?${queryString}` : ADMIN_USERS_PATH,
    callerSignal: signal,
  });
  const hasExpectedShape = Array.isArray(responseData?.users) && typeof responseData?.countsByRole === 'object' && responseData.countsByRole !== null;
  if (!hasExpectedShape) throw new ApiError({ message: API_MESSAGES.UNEXPECTED_RESPONSE, status: httpStatus });
  return { users: responseData.users, countsByRole: responseData.countsByRole };
}

/**
 * Sets a user's role. The affected user's open sessions are disconnected from live updates so
 * the new permissions apply immediately. Resolves to the updated user summary.
 */
export async function requestUpdateUserRole(userId, newRole, csrfToken) {
  const { responseData, httpStatus } = await sendApiRequest({
    method: 'PATCH',
    endpointPath: `${ADMIN_USERS_PATH}/${encodeURIComponent(userId)}/role`,
    requestPayload: { role: newRole },
    csrfToken,
  });
  if (typeof responseData?.user !== 'object' || responseData.user === null) {
    throw new ApiError({ message: API_MESSAGES.UNEXPECTED_RESPONSE, status: httpStatus });
  }
  return responseData.user;
}
