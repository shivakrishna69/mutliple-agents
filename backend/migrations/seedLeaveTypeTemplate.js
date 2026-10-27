/**
 * Gives a company with no leave types the standard template (data/leave-templates/), so leave works
 * from the first start. HR changes or retires these types like any other. Once any leave type
 * exists, including retired ones, nothing is seeded again.
 */

import { readFileSync } from 'node:fs';
import LeaveType from '../models/LeaveType.js';

const DUPLICATE_KEY_ERROR_CODE = 11000;
const TEMPLATE_URL = new URL('../data/leave-templates/india-standard.json', import.meta.url);

export function readLeaveTypeTemplate() {
  return JSON.parse(readFileSync(TEMPLATE_URL, 'utf8')).leaveTypes;
}

export default Object.freeze({
  name: 'seed-leave-type-template',
  async run() {
    if (await LeaveType.exists({})) return { changedCount: 0 };
    try {
      const created = await LeaveType.insertMany(readLeaveTypeTemplate(), { ordered: false });
      return { changedCount: created.length };
    } catch (insertError) {
      // Another instance starting at the same time seeded them first.
      if (insertError?.code !== DUPLICATE_KEY_ERROR_CODE) throw insertError;
      return { changedCount: insertError.insertedDocs?.length ?? 0 };
    }
  },
});
