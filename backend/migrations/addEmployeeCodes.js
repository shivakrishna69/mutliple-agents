/**
 * Gives employee profiles created before employee IDs existed an ID (NSK0001...), in the order the
 * profiles were created, from the same counter new IDs come from. Profiles that have one are not
 * touched. If two instances start together, the second's write finds the ID already set and the
 * number it took is simply never used, like any other unused number.
 */

import EmployeeProfile from '../models/EmployeeProfile.js';
import { issueEmployeeCode } from '../services/companySettings.js';

export default Object.freeze({
  name: 'add-employee-codes',
  async run() {
    const profiles = await EmployeeProfile.find({ employeeCode: { $exists: false } })
      .select('_id')
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    let changedCount = 0;
    for (const profile of profiles) {
      const employeeCode = await issueEmployeeCode();
      const result = await EmployeeProfile.collection.updateOne(
        { _id: profile._id, employeeCode: { $exists: false } },
        { $set: { employeeCode } },
      );
      changedCount += result.modifiedCount;
    }
    return { changedCount };
  },
});
