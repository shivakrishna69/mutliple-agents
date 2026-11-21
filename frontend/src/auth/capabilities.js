import { CAPABILITIES } from '../constants/capabilities.js';
import { ROUTE_PATHS } from '../constants/routes.js';

/**
 * What the signed-in person may do, from the capabilities the server sent with their profile
 * (constants/capabilities.js). Navigation, route guards and page sections use this instead of
 * comparing role names. Only decides what to show: the backend authorises every request.
 */

/** True when `user` has `capability`. A missing user or list means no. */
export function hasCapability(user, capability) {
  return Array.isArray(user?.capabilities) && user.capabilities.includes(capability);
}

/**
 * Where `user` starts, and where a page they may not open sends them: the My Access launcher for
 * everyone with an employee workspace; the Form 16 portal for a chartered accountant; their account otherwise.
 */
export function homePathOf(user) {
  if (hasCapability(user, CAPABILITIES.USE_EMPLOYEE_WORKSPACE)) return ROUTE_PATHS.MY_ACCESS;
  if (hasCapability(user, CAPABILITIES.MANAGE_FORM16)) return ROUTE_PATHS.CA_PORTAL;
  return ROUTE_PATHS.ACCOUNT;
}

/** True when `user` has at least one of `capabilities`. */
export function hasAnyCapability(user, capabilities) {
  return capabilities.some((capability) => hasCapability(user, capability));
}
