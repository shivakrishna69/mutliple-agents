/**
 * Kinds of calendar day and the parts of a day leave can cover, shared by the working-day rules
 * (services/workingDays.js), leave requests (models/LeaveRequest.js) and the API.
 */

export const DAY_KINDS = Object.freeze({ WORKING: 'working', WEEKLY_OFF: 'weekly_off', HOLIDAY: 'holiday' });

export const DAY_PORTIONS = Object.freeze({ FULL: 'full', FIRST_HALF: 'first_half', SECOND_HALF: 'second_half' });
