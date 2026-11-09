/**
 * What the signed-in person may do, from the capabilities the server sent with their profile
 * (constants/capabilities.js). Navigation, route guards and page sections use this instead of
 * comparing role names. Only decides what to show: the backend authorises every request.
 */

/** True when `user` has `capability`. A missing user or list means no. */
export function hasCapability(user, capability) {
  return Array.isArray(user?.capabilities) && user.capabilities.includes(capability);
}

/** True when `user` has at least one of `capabilities`. */
export function hasAnyCapability(user, capabilities) {
  return capabilities.some((capability) => hasCapability(user, capability));
}
