/**
 * Gives leave types created before back-dating existed their `usage.maxBackdatedDays`: the
 * template's value for a template type (matched by code), otherwise 0 (no back-dating). Types that
 * already have a value, including one HR set, are not touched.
 */

import LeaveType from '../models/LeaveType.js';
import { readLeaveTypeTemplate } from './seedLeaveTypeTemplate.js';

const MISSING = { 'usage.maxBackdatedDays': { $exists: false } };

export default Object.freeze({
  name: 'add-leave-type-backdating',
  async run() {
    let changedCount = 0;
    for (const templateType of readLeaveTypeTemplate()) {
      const result = await LeaveType.updateMany(
        { code: templateType.code, ...MISSING },
        { $set: { 'usage.maxBackdatedDays': templateType.usage?.maxBackdatedDays ?? 0 } },
      );
      changedCount += result.modifiedCount;
    }
    const others = await LeaveType.updateMany(MISSING, { $set: { 'usage.maxBackdatedDays': 0 } });
    return { changedCount: changedCount + others.modifiedCount };
  },
});
