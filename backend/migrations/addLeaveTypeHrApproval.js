/**
 * Gives leave types created before multi-level approvals their `usage.hrApprovalAfterDays`: null,
 * meaning the manager alone decides, exactly as before. Written rather than only defaulted on read,
 * so every query sees the same value. Types that already have one are not touched.
 */

import LeaveType from '../models/LeaveType.js';

export default Object.freeze({
  name: 'add-leave-type-hr-approval',
  async run() {
    const result = await LeaveType.updateMany(
      { 'usage.hrApprovalAfterDays': { $exists: false } },
      { $set: { 'usage.hrApprovalAfterDays': null } },
    );
    return { changedCount: result.modifiedCount };
  },
});
