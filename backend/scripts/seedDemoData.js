/**
 * Demo data for walkthroughs and client demos: a small company with departments, a reporting
 * hierarchy, attrition/burnout scores, Q4 OKRs with progress and milestones, and pending attendance
 * reviews, so every workforce screen has something real to show.
 *
 * Usage (from backend/, uses MONGO_URI from backend/.env):
 *   node --env-file=.env scripts/seedDemoData.js [--link <email> ...]
 *   node --env-file=.env scripts/seedDemoData.js --remove
 *
 *   --link <email>   also give an EXISTING account an employee profile in the demo company
 *                    (repeatable). The first linked account becomes the CEO at the top of the org;
 *                    an HR account becomes the HR manager; any other account joins Sales. Accounts
 *                    that already have a profile are left untouched.
 *   --remove         deletes everything this script created (recorded in the demo_seed_registry
 *                    collection), including profiles it added to linked accounts. The linked
 *                    accounts themselves are never deleted.
 *
 * Demo accounts are created as <first>.<last>@demo.novasupport.in with the password printed at the
 * end. Running the script again while demo data exists does nothing (remove first to re-seed).
 * Never run this against a production database: it refuses when NODE_ENV is "production".
 */

import mongoose from 'mongoose';
import Department from '../models/Department.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import KeyResult from '../models/KeyResult.js';
import Objective from '../models/Objective.js';
import RegularizationReview from '../models/RegularizationReview.js';
import User from '../models/User.js';
import { recordEmployeeScores } from '../services/workforceRiskService.js';

const DEMO_EMAIL_DOMAIN = 'demo.novasupport.in';
const DEMO_PASSWORD = 'NovaDemo@2026';
const REGISTRY_COLLECTION = 'demo_seed_registry';

const DEPARTMENTS = [
  { key: 'leadership', name: 'Leadership', code: 'LEAD', budgetCode: 'CC-100' },
  { key: 'engineering', name: 'Engineering', code: 'ENG', budgetCode: 'CC-200' },
  { key: 'sales', name: 'Sales', code: 'SAL', budgetCode: 'CC-300' },
  { key: 'success', name: 'Customer Success', code: 'CS', budgetCode: 'CC-400' },
  { key: 'people', name: 'People Operations', code: 'PEO', budgetCode: 'CC-500' },
];

/** Demo employees. `manager` refers to another key; "ceo" is the top of the org. */
const DEMO_PEOPLE = [
  { key: 'ceo', name: 'Rohan Mehta', role: 'admin', designation: 'Chief Executive Officer', department: 'leadership', manager: null },
  { key: 'hr', name: 'Kavya Reddy', role: 'hr', designation: 'HR Manager', department: 'people', manager: 'ceo' },
  { key: 'engHead', name: 'Priya Sharma', role: 'customer', designation: 'Director of Engineering', department: 'engineering', manager: 'ceo' },
  { key: 'arjun', name: 'Arjun Nair', role: 'customer', designation: 'Senior Software Engineer', department: 'engineering', manager: 'engHead' },
  { key: 'sneha', name: 'Sneha Iyer', role: 'customer', designation: 'Software Engineer', department: 'engineering', manager: 'engHead' },
  { key: 'vikram', name: 'Vikram Rao', role: 'customer', designation: 'QA Engineer', department: 'engineering', manager: 'arjun' },
  { key: 'salesHead', name: 'Karan Malhotra', role: 'customer', designation: 'Head of Sales', department: 'sales', manager: 'ceo' },
  { key: 'ananya', name: 'Ananya Gupta', role: 'customer', designation: 'Account Executive', department: 'sales', manager: 'salesHead' },
  { key: 'csLead', name: 'Meera Joshi', role: 'agent', designation: 'Customer Success Lead', department: 'success', manager: 'ceo' },
  { key: 'rahul', name: 'Rahul Verma', role: 'agent', designation: 'Support Specialist', department: 'success', manager: 'csLead' },
];

const DEPARTMENT_HEADS = { leadership: 'ceo', engineering: 'engHead', sales: 'salesHead', success: 'csLead', people: 'hr' };

/** attrition, burnout (0-100); people not listed stay unscored. */
const RISK_SCORES = {
  arjun: [34, 72], sneha: [81, 66], vikram: [58, 41], ananya: [74, 38], rahul: [22, 18], engHead: [28, 55], salesHead: [46, 33], csLead: [15, 24], hr: [12, 20],
};

function demoEmail(fullName) {
  return `${fullName.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.')}@${DEMO_EMAIL_DOMAIN}`;
}

function parseArguments(argumentList) {
  const linkEmails = [];
  let shouldRemove = false;
  for (let argumentIndex = 0; argumentIndex < argumentList.length; argumentIndex += 1) {
    if (argumentList[argumentIndex] === '--remove') shouldRemove = true;
    else if (argumentList[argumentIndex] === '--link' && argumentList[argumentIndex + 1]) linkEmails.push(argumentList[++argumentIndex].toLowerCase());
    else throw new Error(`Unknown argument: ${argumentList[argumentIndex]}`);
  }
  return { linkEmails, shouldRemove };
}

async function removeDemoData(registry) {
  const entries = await registry.find().toArray();
  if (entries.length === 0) {
    console.log('No demo data to remove.');
    return;
  }
  const idsOf = (kind) => entries.filter((entry) => entry.kind === kind).map((entry) => entry.refId);
  // Reverse dependency order; deleteMany skips model middleware, which is intended for a bulk reset.
  await KeyResult.deleteMany({ _id: { $in: idsOf('keyResult') } });
  await Objective.deleteMany({ _id: { $in: idsOf('objective') } });
  await RegularizationReview.deleteMany({ _id: { $in: idsOf('review') } });
  await EmployeeProfile.collection.updateMany({ _id: { $in: idsOf('profile') } }, { $set: { 'organizationData.reportingManagerId': null } });
  await EmployeeProfile.collection.deleteMany({ _id: { $in: idsOf('profile') } });
  await Department.collection.deleteMany({ _id: { $in: idsOf('department') } });
  await User.deleteMany({ _id: { $in: idsOf('user') } });
  await registry.deleteMany({});
  console.log(`Removed ${entries.length} demo records. Linked accounts were kept (only their demo profiles were removed).`);
}

async function seedDemoData(registry, linkEmails) {
  if ((await registry.countDocuments()) > 0) {
    console.log('Demo data already exists. Run with --remove first to re-seed.');
    return;
  }
  const remember = (kind, refId) => registry.insertOne({ kind, refId, createdAt: new Date() });

  // --- Departments
  const departmentByKey = {};
  for (const departmentSpec of DEPARTMENTS) {
    const existingDepartment = await Department.findOne({ code: departmentSpec.code });
    if (existingDepartment) {
      departmentByKey[departmentSpec.key] = existingDepartment;
      continue;
    }
    const createdDepartment = await Department.create({ name: departmentSpec.name, code: departmentSpec.code, budgetCode: departmentSpec.budgetCode });
    await remember('department', createdDepartment._id);
    departmentByKey[departmentSpec.key] = createdDepartment;
  }

  // --- Linked existing accounts replace demo people where their role fits.
  const people = DEMO_PEOPLE.map((personSpec) => ({ ...personSpec }));
  const linkedUsers = [];
  for (const linkEmail of linkEmails) {
    const existingUser = await User.findOne({ email: linkEmail });
    if (!existingUser) throw new Error(`--link: no account with email ${linkEmail}`);
    if (await EmployeeProfile.exists({ userId: existingUser._id })) {
      console.log(`  ${linkEmail} already has an employee profile; left untouched.`);
      continue;
    }
    linkedUsers.push(existingUser);
  }
  linkedUsers.forEach((linkedUser, linkIndex) => {
    if (linkIndex === 0) Object.assign(people.find((personSpec) => personSpec.key === 'ceo'), { existingUser: linkedUser, name: linkedUser.name });
    else if (linkedUser.role === 'hr' && !people.find((personSpec) => personSpec.key === 'hr').existingUser) Object.assign(people.find((personSpec) => personSpec.key === 'hr'), { existingUser: linkedUser, name: linkedUser.name });
    else people.push({ key: `linked${linkIndex}`, name: linkedUser.name, role: linkedUser.role, designation: 'Sales Executive', department: 'sales', manager: 'salesHead', existingUser: linkedUser });
  });

  // --- Accounts and profiles, managers first (the list is ordered so every manager precedes its reports).
  const profileByKey = {};
  const userIdByKey = {};
  for (const personSpec of people) {
    let accountId = personSpec.existingUser?._id;
    if (!accountId) {
      const demoUser = await User.create({ name: personSpec.name, email: demoEmail(personSpec.name), password: DEMO_PASSWORD, role: personSpec.role });
      await remember('user', demoUser._id);
      accountId = demoUser._id;
    }
    userIdByKey[personSpec.key] = accountId;
    const profile = await EmployeeProfile.create({
      userId: accountId,
      organizationData: {
        designation: personSpec.designation,
        departmentId: departmentByKey[personSpec.department]._id,
        reportingManagerId: personSpec.manager ? profileByKey[personSpec.manager]._id : null,
        workLocationType: 'Hybrid',
        dateOfJoining: new Date(Date.UTC(2023 + (personSpec.key.length % 3), personSpec.key.length % 12, 1)),
        employmentStatus: 'Active',
      },
    });
    await remember('profile', profile._id);
    profileByKey[personSpec.key] = profile;
  }

  for (const [departmentKey, headKey] of Object.entries(DEPARTMENT_HEADS)) {
    const department = departmentByKey[departmentKey];
    if (!department.departmentHeadId) {
      department.departmentHeadId = profileByKey[headKey]._id;
      await department.save();
    }
  }

  // --- Workforce risk scores
  const scoreResult = await recordEmployeeScores({
    modelVersion: 'attrition-demo-v1',
    computedAt: new Date(),
    scores: Object.entries(RISK_SCORES).map(([personKey, [attritionRiskIndex, currentBurnoutScore]]) => ({ employeeId: profileByKey[personKey]._id.toString(), attritionRiskIndex, currentBurnoutScore })),
  });

  // --- OKRs for the current quarter
  const today = new Date();
  const period = { year: today.getFullYear(), quarter: Math.floor(today.getMonth() / 3) + 1 };
  const quarterEnd = new Date(Date.UTC(period.year, period.quarter * 3, 0)).toISOString().slice(0, 10);
  const createdByUserId = userIdByKey.hr;

  async function createObjective(spec) {
    const objective = await Objective.create({ ...spec, period, createdByUserId });
    await remember('objective', objective._id);
    return objective;
  }
  async function createKeyResult(objective, { title, owner, unit, startValue, targetValue, currentValue, weight = 1, milestones = [], note }) {
    const keyResult = await KeyResult.create({
      objectiveId: objective._id,
      title,
      ownerEmployeeId: profileByKey[owner]._id,
      unit,
      startValue,
      targetValue,
      currentValue,
      weight,
      milestones: milestones.map(([milestoneTitle, isDone, dueDate]) => ({
        title: milestoneTitle,
        dueDate: dueDate ?? quarterEnd,
        status: isDone ? 'done' : 'pending',
        completedAt: isDone ? new Date() : null,
        completedByUserId: isDone ? userIdByKey[owner] : null,
      })),
      checkIns: note ? [{ value: currentValue, note, byUserId: userIdByKey[owner], at: new Date() }] : [],
    });
    await remember('keyResult', keyResult._id);
  }

  const supportGoal = await createObjective({ level: 'company', title: 'Deliver world-class AI-first customer support', description: 'Faster, friendlier resolutions with AI handling routine questions.', ownerEmployeeId: profileByKey.ceo._id });
  await createKeyResult(supportGoal, { title: 'Raise CSAT from 78% to 92%', owner: 'csLead', unit: 'percent', startValue: 78, targetValue: 92, currentValue: 86, weight: 2, note: 'New macros shipped', milestones: [['Launch post-chat survey', true], ['Weekly CSAT review ritual', true], ['Close top 10 detractor themes', false]] });
  await createKeyResult(supportGoal, { title: 'AI resolves 60% of conversations without handoff', owner: 'engHead', unit: 'percent', startValue: 35, targetValue: 60, currentValue: 48 });

  const growthGoal = await createObjective({ level: 'company', title: 'Grow annual recurring revenue', description: 'Expand in mid-market accounts across India.', ownerEmployeeId: profileByKey.ceo._id });
  await createKeyResult(growthGoal, { title: 'Reach ₹12 Cr ARR', owner: 'salesHead', unit: 'currency_inr', startValue: 80000000, targetValue: 120000000, currentValue: 97000000, weight: 2 });
  await createKeyResult(growthGoal, { title: 'Cut logo churn from 6% to 3%', owner: 'csLead', unit: 'percent', startValue: 6, targetValue: 3, currentValue: 4.5 });

  const triageGoal = await createObjective({ level: 'team', title: 'Ship AI triage v2', parentObjectiveId: supportGoal._id, departmentId: departmentByKey.engineering._id, ownerEmployeeId: profileByKey.engHead._id });
  await createKeyResult(triageGoal, { title: 'Automate 40 ticket categories', owner: 'arjun', unit: 'count', startValue: 0, targetValue: 40, currentValue: 26, note: 'Billing + login categories live', milestones: [['Design review', true], ['Pilot with billing queue', true], ['General availability', false]] });
  await createKeyResult(triageGoal, { title: 'Keep p95 AI reply latency under 3 s', owner: 'sneha', unit: 'score', startValue: 0, targetValue: 100, currentValue: 70 });

  const successGoal = await createObjective({ level: 'team', title: 'Make every escalation a great experience', parentObjectiveId: supportGoal._id, departmentId: departmentByKey.success._id, ownerEmployeeId: profileByKey.csLead._id });
  await createKeyResult(successGoal, { title: 'First response under 5 minutes for 90% of escalations', owner: 'rahul', unit: 'percent', startValue: 60, targetValue: 90, currentValue: 81, milestones: [['On-call rota for weekends', true], ['Escalation playbook v2', false]] });

  const pipelineGoal = await createObjective({ level: 'team', title: 'Build a predictable mid-market pipeline', parentObjectiveId: growthGoal._id, departmentId: departmentByKey.sales._id, ownerEmployeeId: profileByKey.salesHead._id });
  await createKeyResult(pipelineGoal, { title: 'Book 45 qualified demos', owner: 'ananya', unit: 'count', startValue: 0, targetValue: 45, currentValue: 19, milestones: [['Partner webinar series', true], ['Outbound to top 200 accounts', false]] });

  // --- Pending attendance reviews (escalated by the AI agent) for managers to decide
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const reviewSpecs = [
    { person: 'sneha', date: yesterday, claimedPunchInTime: '09:40', reason: 'Forgot to punch in; was in the sprint planning room from 9:40.', routingReason: 'no_activity_proof', qualifyingEventCount: 0 },
    { person: 'vikram', date: twoDaysAgo, claimedPunchInTime: '10:05', reason: 'Phone battery died on the way in.', routingReason: 'clarification_limit_reached', qualifyingEventCount: 2 },
    { person: 'ananya', date: yesterday, claimedPunchInTime: '09:15', reason: 'Client visit first thing, came to office after.', routingReason: 'activity_systems_unavailable', qualifyingEventCount: 1 },
  ];
  for (const reviewSpec of reviewSpecs) {
    const employeeProfile = profileByKey[reviewSpec.person];
    const review = await RegularizationReview.create({
      employeeId: employeeProfile._id,
      requestedByUserId: userIdByKey[reviewSpec.person],
      reportingManagerId: employeeProfile.organizationData.reportingManagerId,
      date: reviewSpec.date,
      claimedPunchInTime: reviewSpec.claimedPunchInTime,
      reason: reviewSpec.reason,
      routingReason: reviewSpec.routingReason,
      qualifyingEventCount: reviewSpec.qualifyingEventCount,
      idempotencyKey: `demo-seed:${reviewSpec.person}:${reviewSpec.date}`,
    });
    await remember('review', review._id);
  }

  console.log('\nDemo company created.');
  console.log(`  ${people.length} employees in ${DEPARTMENTS.length} departments, ${scoreResult.updated} risk scores, 5 objectives, 8 key results, ${reviewSpecs.length} pending attendance reviews (Q${period.quarter} ${period.year}).`);
  console.log(`\nDemo sign-ins (password for all: ${DEMO_PASSWORD}):`);
  for (const personSpec of people) {
    const signIn = personSpec.existingUser ? `${personSpec.existingUser.email} (your existing account)` : demoEmail(personSpec.name);
    console.log(`  ${personSpec.role.padEnd(8)} ${personSpec.name.padEnd(20)} ${personSpec.designation.padEnd(26)} ${signIn}`);
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set (expected in backend/.env)');
  const { linkEmails, shouldRemove } = parseArguments(process.argv.slice(2));
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    const registry = mongoose.connection.collection(REGISTRY_COLLECTION);
    if (shouldRemove) await removeDemoData(registry);
    else await seedDemoData(registry, linkEmails);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((seedError) => {
  console.error(`Demo seed failed: ${seedError.message}`);
  process.exitCode = 1;
});
