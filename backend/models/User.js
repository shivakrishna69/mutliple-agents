/**
 * User model: every account that can authenticate against the backend.
 *
 * Roles and what they are for:
 *   - admin    : manages users and system settings; can view every conversation.
 *   - agent    : a human support agent; can claim escalated conversations
 *                (Conversation.assignedAgentId references a user with this role).
 *   - hr       : HR staff; manages employee records and documents in the document vault
 *                (DocumentVault.accessibleRoles). Has no access to the support console.
 *   - customer : opens conversations (Conversation.customerId references a user with this role).
 *   Public signup always creates customers; admins promote accounts to agent, hr or admin.
 *
 * Password handling:
 *   - `password` stores a bcrypt hash, never plaintext. The `pre('save')` hook is the single
 *     place hashing happens: callers assign the plaintext and call `save()`. Controllers must
 *     not hash first, or the stored value would be a hash of a hash and logins would fail.
 *   - `select: false` keeps the hash out of every query result unless the caller asks for
 *     it explicitly with `.select('+password')`, which only the login flow should do.
 *   - `toJSON` strips the hash as a second guard in case a document fetched with
 *     `+password` is serialised into a response.
 *
 * Audit note: role changes are ordinary updates and are not versioned here; `updatedAt`
 * records only when the document last changed, not what changed.
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { EMAIL_PATTERN, USER_FIELD_LIMITS } from '../constants/validation.js';
import { invalidateOrgHierarchyCache } from '../services/orgHierarchyCache.js';

/** Allowed values for `role`. Import this instead of repeating the strings in route code. */
export const ROLES = Object.freeze({
  ADMIN: 'admin',
  AGENT: 'agent',
  HR: 'hr',
  CUSTOMER: 'customer',
});

/**
 * bcrypt cost factor. 12 rounds takes roughly 200–300 ms per hash on current server CPUs:
 * slow enough to make offline guessing expensive, fast enough for interactive login.
 * Exported so the login flow can hash its timing-equalisation dummy at the same cost.
 */
export const BCRYPT_SALT_ROUNDS = 12;

/**
 * Account lifecycle:
 *   unverified  signed up, but has not opened the emailed confirmation link yet; cannot sign in.
 *               A new signup with the same email replaces it (services/accountEmailFlows.js), so
 *               whoever typed an address first cannot keep its real owner out.
 *   invited     created by HR or a bulk import, no password yet; cannot sign in
 *   active      the person chose a password through their activation link, or confirmed the email
 *               they signed up with
 *   disabled    the invitation was revoked or the account switched off; cannot sign in
 */
export const ACCOUNT_STATUSES = Object.freeze({
  UNVERIFIED: 'unverified',
  INVITED: 'invited',
  ACTIVE: 'active',
  DISABLED: 'disabled',
});

const emailField = () => ({
  type: String,
  lowercase: true,
  trim: true,
  default: null,
  maxlength: USER_FIELD_LIMITS.EMAIL_MAX_LENGTH,
  validate: { validator: (email) => email === null || EMAIL_PATTERN.test(email), message: 'Email is not valid' },
});

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: USER_FIELD_LIMITS.NAME_MIN_LENGTH,
      maxlength: USER_FIELD_LIMITS.NAME_MAX_LENGTH,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      // Stored normalised so that "User@Example.com" and "user@example.com" are the same account.
      lowercase: true,
      trim: true,
      maxlength: USER_FIELD_LIMITS.EMAIL_MAX_LENGTH,
      match: [EMAIL_PATTERN, 'Email is not valid'],
    },
    password: {
      type: String,
      // An invited account has none until the person opens their activation link and chooses one.
      required: [
        function passwordIsRequired() {
          return this.status !== ACCOUNT_STATUSES.INVITED;
        },
        'Password is required',
      ],
      // Length is validated on the plaintext: Mongoose runs validation before the pre('save') hash.
      // The 72-byte upper bound is enforced by the request validator, which can measure bytes.
      minlength: [USER_FIELD_LIMITS.PASSWORD_MIN_LENGTH, 'Password is too short'],
      select: false,
    },
    // When the password was last changed. Sessions issued before this are rejected
    // (services/sessionAuthenticator.loadSessionUser), which signs out other devices.
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    role: {
      type: String,
      enum: { values: Object.values(ROLES), message: 'Role "{VALUE}" is not valid' },
      default: ROLES.CUSTOMER,
      required: true,
    },
    // Only active accounts can sign in (controllers/authController.js) or keep a session.
    status: {
      type: String,
      enum: { values: Object.values(ACCOUNT_STATUSES), message: 'Account status "{VALUE}" is not valid' },
      default: ACCOUNT_STATUSES.ACTIVE,
      required: true,
    },
    // When the person proved they own `email`: the signup confirmation link, or the invitation link
    // (which was sent to that address). Null until then.
    emailVerifiedAt: {
      type: Date,
      default: null,
    },
    // Where invitations go: the person's own address. The sign-in email starts as the same address.
    personalEmail: emailField(),
    // The address at the company's mail domain, once there is one (services/companyEmail.js).
    companyEmail: emailField(),
    // False until the person has filled in the details they keep themselves (photo, contact...).
    profileCompleted: { type: Boolean, default: false },
    // Which version of the presence notice (constants/validation.js PRESENCE_NOTICE_VERSION) the
    // person acknowledged, and when. Their activity is recorded only once the current one is.
    presenceNotice: {
      version: { type: Number, default: null },
      acknowledgedAt: { type: Date, default: null },
    },
  },
  {
    // Adds createdAt and updatedAt, maintained by Mongoose on save and update queries.
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// `unique: true` on email creates the unique index used by login lookups.
// This index serves the admin screen that lists users filtered by role, newest first.
userSchema.index({ role: 1, createdAt: -1 });
// One account per company address. Partial: most accounts have none (yet).
userSchema.index({ companyEmail: 1 }, { unique: true, partialFilterExpression: { companyEmail: { $type: 'string' } } });

/**
 * Hashes the password before it is written. The `isModified` check prevents re-hashing
 * an existing hash when another field (such as role) is updated and the document is saved.
 *
 * Note: `findOneAndUpdate` and `updateOne` do not run this hook. Change passwords by
 * loading the document, assigning `user.password`, and calling `user.save()`.
 */
userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, BCRYPT_SALT_ROUNDS);
});

/**
 * Compares a plaintext candidate with the stored hash. The document must have been
 * loaded with `.select('+password')`; otherwise the hash is absent and this throws,
 * which surfaces the mistake instead of rejecting every login silently.
 */
userSchema.methods.comparePassword = async function comparePassword(candidatePassword) {
  if (!this.password) {
    throw new Error('comparePassword requires the user to be loaded with .select("+password")');
  }
  return bcrypt.compare(candidatePassword, this.password);
};

// ---------------------------------------------------------------------------
// Org chart cache invalidation
// ---------------------------------------------------------------------------

/**
 * The cached org hierarchy shows each employee's `name` from this collection, so renaming or
 * deleting an account marks it stale. Other user changes (role, password) do not affect the chart
 * and do not invalidate it. Hooks are awaited and never throw (services/orgHierarchyCache.js).
 */
const USER_UPDATE_QUERY_OPERATIONS = ['updateOne', 'updateMany', 'findOneAndUpdate'];
const USER_REPLACE_OR_DELETE_OPERATIONS = [
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
];

/** True when a query update writes `name` (top level or inside an operator such as $set). */
function updateTouchesName(update) {
  return Object.entries(update ?? {}).some(
    ([updateKey, updateValue]) =>
      updateKey === 'name' ||
      (updateKey.startsWith('$') && updateValue !== null && typeof updateValue === 'object' && 'name' in updateValue),
  );
}

userSchema.pre('save', function recordNameChange() {
  // Captured before saving: after save() Mongoose resets the modified-paths tracking.
  this.$locals.hasNameChanged = !this.isNew && this.isModified('name');
});
userSchema.post('save', async function invalidateOrgChartAfterRename() {
  if (this.$locals.hasNameChanged) await invalidateOrgHierarchyCache('user renamed');
});
userSchema.post('deleteOne', { document: true, query: false }, async function invalidateOrgChartAfterDocumentDelete() {
  await invalidateOrgHierarchyCache('user deleted');
});
userSchema.post(USER_UPDATE_QUERY_OPERATIONS, async function invalidateOrgChartAfterQueryRename() {
  if (updateTouchesName(this.getUpdate())) await invalidateOrgHierarchyCache(`user ${this.op}`);
});
userSchema.post(USER_REPLACE_OR_DELETE_OPERATIONS, async function invalidateOrgChartAfterReplaceOrDelete() {
  await invalidateOrgHierarchyCache(`user ${this.op}`);
});

const User = mongoose.model('User', userSchema);

export default User;
