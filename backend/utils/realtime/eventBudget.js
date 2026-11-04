/**
 * A fixed-window event budget per socket, so one client cannot flood the server with events
 * (conversation joins, presence reports). Each kind of event has its own window object.
 */

/** A fresh window, for a socket's connection record. */
export function createEventWindow() {
  return { eventCount: 0, windowStartedAtMs: Date.now() };
}

/**
 * Counts one event. Returns false when the budget for the current window is spent.
 * @param {{ eventCount: number, windowStartedAtMs: number }} eventWindow  updated in place
 * @param {{ windowMs: number, limit: number }} budget
 */
export function consumeEventBudget(eventWindow, { windowMs, limit }) {
  const currentTimeMs = Date.now();
  if (currentTimeMs - eventWindow.windowStartedAtMs >= windowMs) {
    eventWindow.windowStartedAtMs = currentTimeMs;
    eventWindow.eventCount = 0;
  }
  eventWindow.eventCount += 1;
  return eventWindow.eventCount <= limit;
}
