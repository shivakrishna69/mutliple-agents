/**
 * The user fields that may be sent to clients, and the projection that loads exactly those.
 *
 * An explicit allowlist (rather than deleting the password from a copy) guarantees that any
 * field added to the User model later stays private until someone deliberately exposes it here.
 */

/** Mongoose projection for the public profile. The password is never selected. */
export const PUBLIC_USER_PROFILE_FIELDS = '_id name email role createdAt updatedAt';

/** Builds the client-facing user object from a User document or lean record. */
export function toPublicUserProfile(userRecord) {
  return {
    id: userRecord._id.toString(),
    name: userRecord.name,
    email: userRecord.email,
    role: userRecord.role,
    createdAt: userRecord.createdAt,
    updatedAt: userRecord.updatedAt,
  };
}
