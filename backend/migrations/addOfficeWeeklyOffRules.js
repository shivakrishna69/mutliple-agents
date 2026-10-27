/**
 * Gives offices created before weekly offs existed the default rules (Saturday and Sunday every
 * week). HR can change each office's rules afterwards. Offices that already have rules, including
 * an empty list deliberately set by HR, are not touched.
 */

import OfficeLocation, { defaultWeeklyOffRules } from '../models/OfficeLocation.js';

export default Object.freeze({
  name: 'add-office-weekly-off-rules',
  async run() {
    const result = await OfficeLocation.updateMany(
      { 'workday.weeklyOffRules': { $exists: false } },
      { $set: { 'workday.weeklyOffRules': defaultWeeklyOffRules() } },
    );
    return { changedCount: result.modifiedCount };
  },
});
