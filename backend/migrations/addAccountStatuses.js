/**
 * Accounts created before account statuses existed were all usable, so they become "active"; their
 * owners have been using them, so their profile counts as completed. Accounts that already have a
 * status are not touched.
 */

import User, { ACCOUNT_STATUSES } from '../models/User.js';

export default Object.freeze({
  name: 'add-account-statuses',
  async run() {
    const result = await User.updateMany(
      { status: { $exists: false } },
      { $set: { status: ACCOUNT_STATUSES.ACTIVE, profileCompleted: true } },
    );
    return { changedCount: result.modifiedCount };
  },
});
