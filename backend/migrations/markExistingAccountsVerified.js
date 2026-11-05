/**
 * Accounts that existed before email verification were usable without it, so they count as verified
 * from when they were created; nobody is locked out by the new rule. Only accounts with a password
 * qualify (people who have signed in or can); invited accounts are verified when their owner opens
 * the invitation link. Accounts created since have `emailVerifiedAt` set (null or a date), so they
 * are never touched.
 */

import User from '../models/User.js';

export default Object.freeze({
  name: 'mark-existing-accounts-verified',
  async run() {
    const result = await User.updateMany({ emailVerifiedAt: { $exists: false }, password: { $exists: true } }, [
      { $set: { emailVerifiedAt: { $ifNull: ['$createdAt', '$$NOW'] } } },
    ]);
    return { changedCount: result.modifiedCount };
  },
});
