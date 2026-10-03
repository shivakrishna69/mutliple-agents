/**
 * Command-line recovery tool to change a user's role. Day-to-day role changes are made by an admin on
 * the Users & roles page (PATCH /api/admin/users/:userId/role), and the first admin comes from
 * BOOTSTRAP_ADMIN_EMAIL. This tool is for when no admin can sign in. It talks to MongoDB directly
 * (MONGO_URI from backend/.env), so only someone with server and database access can use it.
 *
 * Usage (from the backend directory):
 *   npm run set-role -- <email> <admin|agent|hr|customer>
 *   node scripts/setUserRole.js agent.smith@example.com agent
 *
 * The change applies to HTTP requests immediately (every request reloads the user). Open socket
 * connections keep the previous role until they reconnect, so after demoting a staff member, also
 * have them sign out, or restart the backend.
 *
 * Exit codes: 0 updated or already had the role, 1 invalid arguments, 2 user not found,
 * 3 configuration or database error.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import User, { ROLES } from '../models/User.js';

const ALLOWED_ROLES = Object.values(ROLES);

function printUsage() {
  console.error(`Usage: node scripts/setUserRole.js <email> <${ALLOWED_ROLES.join('|')}>`);
}

async function main() {
  const [rawEmail, rawRole] = process.argv.slice(2);
  if (!rawEmail || !rawRole) {
    printUsage();
    return 1;
  }
  const email = rawEmail.trim().toLowerCase();
  const role = rawRole.trim().toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) {
    console.error(`Invalid role "${rawRole}". Allowed: ${ALLOWED_ROLES.join(', ')}`);
    return 1;
  }
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set (expected in backend/.env)');
    return 3;
  }

  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
    const userRecord = await User.findOne({ email });
    if (!userRecord) {
      console.error(`No user with email ${email}. They must sign up first.`);
      return 2;
    }
    const previousRole = userRecord.role;
    if (previousRole === role) {
      console.log(`${email} already has role "${role}"; nothing changed.`);
      return 0;
    }
    userRecord.role = role;
    await userRecord.save();
    console.log(`${email}: role changed from "${previousRole}" to "${role}".`);
    return 0;
  } catch (databaseError) {
    console.error(`Database error: ${databaseError.message}`);
    return 3;
  } finally {
    await mongoose.disconnect();
  }
}

process.exitCode = await main();
