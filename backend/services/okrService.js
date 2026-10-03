/**
 * OKR rules and queries: who may do what, the alignment tree, and progress roll-ups.
 *
 * Permissions (resolved per request from the database, never from the client)
 *   view               admins, HR, and anyone with an employee profile (OKRs are internal)
 *   create company     admins and HR
 *   create team        admins, HR, and the head of that department (Department.departmentHeadId)
 *   manage objective   admins, HR, its owner, and for team objectives the department head:
 *                      edit it, archive it, add key results
 *   update key result  everyone who may manage its objective, plus the key result's owner:
 *                      progress (slider), milestones
 *
 * Progress roll-up (derived on every read, never stored)
 *   key result         clamp((current − start) / (target − start)) × 100
 *   objective          weighted mean of its active key results (null when it has none)
 *   company objective  progress = its own key results; alignedProgress = mean of its active team
 *                      objectives' progress; rollupProgress = mean of whichever of those exist
 *
 * The alignment tree for a quarter is built from four queries (objectives, key results, departments,
 * people) and assembled in memory, so its cost does not grow with the number of nodes.
 */

import mongoose from 'mongoose';
import Department from '../models/Department.js';
import EmployeeProfile from '../models/EmployeeProfile.js';
import KeyResult, { MILESTONE_STATUSES, computeKeyResultProgress } from '../models/KeyResult.js';
import Objective, { OBJECTIVE_LEVELS, OKR_STATUSES } from '../models/Objective.js';
import User, { ROLES } from '../models/User.js';
import { OKR_FIELD_LIMITS } from '../constants/validation.js';

const ORGANISATION_WIDE_ROLES = Object.freeze([ROLES.ADMIN, ROLES.HR]);

/** An expected failure the controller returns as-is. */
export class OkrError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'OkrError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

// =================================================================================================
// Viewer and permissions
// =================================================================================================

/**
 * Everything permission checks need about the requesting user.
 * @returns {Promise<{ userId: string, isOrganisationWide: boolean, profileId: string|null, headedDepartmentIds: Set<string> }>}
 */
export async function loadOkrViewer(user) {
  const ownProfile = await EmployeeProfile.findOne({ userId: user.id }).select('_id').lean();
  const profileId = ownProfile ? ownProfile._id.toString() : null;
  const headedDepartments = profileId ? await Department.find({ departmentHeadId: profileId }).select('_id').lean() : [];
  return {
    userId: user.id,
    isOrganisationWide: ORGANISATION_WIDE_ROLES.includes(user.role),
    profileId,
    headedDepartmentIds: new Set(headedDepartments.map((department) => department._id.toString())),
  };
}

export function canViewOkrs(viewer) {
  return viewer.isOrganisationWide || viewer.profileId !== null;
}

export function canCreateObjective(viewer, level, departmentId) {
  if (viewer.isOrganisationWide) return true;
  return level === OBJECTIVE_LEVELS.TEAM && departmentId !== null && viewer.headedDepartmentIds.has(departmentId);
}

export function canManageObjective(viewer, objective) {
  if (viewer.isOrganisationWide) return true;
  if (viewer.profileId && objective.ownerEmployeeId.toString() === viewer.profileId) return true;
  return objective.level === OBJECTIVE_LEVELS.TEAM && viewer.headedDepartmentIds.has(objective.departmentId.toString());
}

export function canUpdateKeyResult(viewer, keyResult, objective) {
  return canManageObjective(viewer, objective) || Boolean(viewer.profileId && keyResult.ownerEmployeeId.toString() === viewer.profileId);
}

// =================================================================================================
// Progress
// =================================================================================================

function weightedMean(progressEntries) {
  const totalWeight = progressEntries.reduce((runningTotal, entry) => runningTotal + entry.weight, 0);
  if (totalWeight === 0) return null;
  return Math.round((progressEntries.reduce((runningTotal, entry) => runningTotal + entry.progress * entry.weight, 0) / totalWeight) * 10) / 10;
}

function plainMean(values) {
  const presentValues = values.filter((value) => value !== null);
  return presentValues.length ? Math.round((presentValues.reduce((runningTotal, value) => runningTotal + value, 0) / presentValues.length) * 10) / 10 : null;
}

// =================================================================================================
// Alignment tree
// =================================================================================================

/**
 * The quarter's OKR canvas: company objectives, each with its own key results and its aligned team
 * objectives grouped by department, each node carrying progress and the viewer's edit rights.
 */
export async function buildAlignmentTree(viewer, { year, quarter }) {
  const objectives = await Objective.find({ 'period.year': year, 'period.quarter': quarter, status: OKR_STATUSES.ACTIVE }).sort({ createdAt: 1 }).lean();
  const objectiveIds = objectives.map((objective) => objective._id);
  const keyResults = objectiveIds.length ? await KeyResult.find({ objectiveId: { $in: objectiveIds }, status: OKR_STATUSES.ACTIVE }).sort({ createdAt: 1 }).lean() : [];

  const ownerProfileIds = [...new Set([...objectives.map((objective) => objective.ownerEmployeeId.toString()), ...keyResults.map((keyResult) => keyResult.ownerEmployeeId.toString())])];
  const [ownerProfiles, departments] = await Promise.all([
    EmployeeProfile.find({ _id: { $in: ownerProfileIds } }).select('userId organizationData.designation').lean(),
    Department.find({ _id: { $in: objectives.filter((objective) => objective.departmentId).map((objective) => objective.departmentId) } }).select('name code').lean(),
  ]);
  const ownerAccounts = await User.find({ _id: { $in: ownerProfiles.map((profile) => profile.userId) } }).select('name').lean();
  const accountNameById = new Map(ownerAccounts.map((account) => [account._id.toString(), account.name]));
  const personById = new Map(
    ownerProfiles.map((profile) => [profile._id.toString(), { employeeId: profile._id.toString(), name: accountNameById.get(profile.userId.toString()) ?? null, designation: profile.organizationData.designation }]),
  );
  const departmentById = new Map(departments.map((department) => [department._id.toString(), { departmentId: department._id.toString(), name: department.name, code: department.code }]));

  const keyResultsByObjectiveId = new Map();
  for (const keyResult of keyResults) {
    const objectiveKey = keyResult.objectiveId.toString();
    if (!keyResultsByObjectiveId.has(objectiveKey)) keyResultsByObjectiveId.set(objectiveKey, []);
    keyResultsByObjectiveId.get(objectiveKey).push(keyResult);
  }

  const toKeyResultNode = (keyResult, objective) => ({
    id: keyResult._id.toString(),
    title: keyResult.title,
    owner: personById.get(keyResult.ownerEmployeeId.toString()) ?? null,
    unit: keyResult.unit,
    startValue: keyResult.startValue,
    targetValue: keyResult.targetValue,
    currentValue: keyResult.currentValue,
    progress: computeKeyResultProgress(keyResult),
    weight: keyResult.weight,
    version: keyResult.__v,
    milestones: keyResult.milestones.map((milestone) => ({
      id: milestone._id.toString(),
      title: milestone.title,
      dueDate: milestone.dueDate,
      status: milestone.status,
      completedAt: milestone.completedAt ? new Date(milestone.completedAt).toISOString() : null,
    })),
    milestoneSummary: { done: keyResult.milestones.filter((milestone) => milestone.status === MILESTONE_STATUSES.DONE).length, total: keyResult.milestones.length },
    lastCheckIn: keyResult.checkIns.length ? { value: keyResult.checkIns.at(-1).value, note: keyResult.checkIns.at(-1).note, at: new Date(keyResult.checkIns.at(-1).at).toISOString() } : null,
    canUpdate: canUpdateKeyResult(viewer, keyResult, objective),
  });

  const toObjectiveNode = (objective) => {
    const keyResultNodes = (keyResultsByObjectiveId.get(objective._id.toString()) ?? []).map((keyResult) => toKeyResultNode(keyResult, objective));
    return {
      id: objective._id.toString(),
      title: objective.title,
      description: objective.description,
      level: objective.level,
      owner: personById.get(objective.ownerEmployeeId.toString()) ?? null,
      progress: weightedMean(keyResultNodes.map((keyResultNode) => ({ progress: keyResultNode.progress, weight: keyResultNode.weight }))),
      keyResults: keyResultNodes,
      canManage: canManageObjective(viewer, objective),
      version: objective.__v,
    };
  };

  const teamObjectivesByParentId = new Map();
  for (const objective of objectives.filter((candidate) => candidate.level === OBJECTIVE_LEVELS.TEAM)) {
    const parentKey = objective.parentObjectiveId.toString();
    if (!teamObjectivesByParentId.has(parentKey)) teamObjectivesByParentId.set(parentKey, []);
    teamObjectivesByParentId.get(parentKey).push(objective);
  }

  const companyObjectives = objectives
    .filter((objective) => objective.level === OBJECTIVE_LEVELS.COMPANY)
    .map((companyObjective) => {
      const companyNode = toObjectiveNode(companyObjective);
      const teamNodesByDepartment = new Map();
      for (const teamObjective of teamObjectivesByParentId.get(companyObjective._id.toString()) ?? []) {
        const departmentKey = teamObjective.departmentId.toString();
        if (!teamNodesByDepartment.has(departmentKey)) {
          teamNodesByDepartment.set(departmentKey, { department: departmentById.get(departmentKey) ?? { departmentId: departmentKey, name: null, code: null }, objectives: [] });
        }
        teamNodesByDepartment.get(departmentKey).objectives.push(toObjectiveNode(teamObjective));
      }
      const teams = [...teamNodesByDepartment.values()];
      for (const team of teams) team.progress = plainMean(team.objectives.map((objectiveNode) => objectiveNode.progress));
      const alignedProgress = plainMean(teams.flatMap((team) => team.objectives.map((objectiveNode) => objectiveNode.progress)));
      return { ...companyNode, alignedProgress, rollupProgress: plainMean([companyNode.progress, alignedProgress]), teams };
    });

  return {
    period: { year, quarter },
    companyObjectives,
    meta: {
      objectiveCount: objectives.length,
      keyResultCount: keyResults.length,
      overallProgress: plainMean(companyObjectives.map((companyObjective) => companyObjective.rollupProgress)),
      canCreateCompanyObjective: viewer.isOrganisationWide,
      headedDepartmentIds: [...viewer.headedDepartmentIds],
      viewerEmployeeId: viewer.profileId,
    },
  };
}

// =================================================================================================
// Mutations
// =================================================================================================

async function requireOwnerProfile(ownerEmployeeId) {
  if (!(await EmployeeProfile.exists({ _id: ownerEmployeeId }))) throw new OkrError(400, 'OWNER_NOT_FOUND', 'ownerEmployeeId does not match an employee');
}

export async function createObjective(viewer, input) {
  const departmentId = input.level === OBJECTIVE_LEVELS.TEAM ? input.departmentId : null;
  if (!canCreateObjective(viewer, input.level, departmentId)) {
    throw new OkrError(403, 'OKR_FORBIDDEN', input.level === OBJECTIVE_LEVELS.COMPANY ? 'Only HR and administrators can create company objectives' : 'Only HR, administrators and the department head can create team objectives');
  }
  await requireOwnerProfile(input.ownerEmployeeId);
  if (input.level === OBJECTIVE_LEVELS.TEAM) {
    if (!(await Department.exists({ _id: departmentId }))) throw new OkrError(404, 'DEPARTMENT_NOT_FOUND', 'Department not found');
    const parentObjective = await Objective.findById(input.parentObjectiveId).lean();
    if (!parentObjective || parentObjective.level !== OBJECTIVE_LEVELS.COMPANY) throw new OkrError(400, 'PARENT_INVALID', 'parentObjectiveId must be a company objective');
    if (parentObjective.status !== OKR_STATUSES.ACTIVE) throw new OkrError(409, 'PARENT_ARCHIVED', 'The company objective is archived');
    if (parentObjective.period.year !== input.period.year || parentObjective.period.quarter !== input.period.quarter) {
      throw new OkrError(400, 'PERIOD_MISMATCH', 'A team objective must be in the same quarter as its company objective');
    }
  }
  return Objective.create({
    title: input.title,
    description: input.description,
    level: input.level,
    period: input.period,
    parentObjectiveId: input.level === OBJECTIVE_LEVELS.TEAM ? input.parentObjectiveId : null,
    departmentId,
    ownerEmployeeId: input.ownerEmployeeId,
    createdByUserId: viewer.userId,
  });
}

/** Loads an objective the viewer may manage, at the expected version. */
async function loadManagedObjective(viewer, objectiveId, expectedVersion) {
  const objective = await Objective.findById(objectiveId);
  if (!objective) throw new OkrError(404, 'OBJECTIVE_NOT_FOUND', 'Objective not found');
  if (!canManageObjective(viewer, objective)) throw new OkrError(403, 'OKR_FORBIDDEN', 'You cannot change this objective');
  if (expectedVersion !== undefined && objective.__v !== expectedVersion) throw new OkrError(409, 'STALE_VERSION', 'This objective was changed by someone else. Reload and try again');
  return objective;
}

export async function updateObjective(viewer, objectiveId, changes) {
  const objective = await loadManagedObjective(viewer, objectiveId, changes.version);
  if (changes.ownerEmployeeId !== undefined) await requireOwnerProfile(changes.ownerEmployeeId);
  for (const fieldName of ['title', 'description', 'ownerEmployeeId', 'status']) {
    if (changes[fieldName] !== undefined) objective[fieldName] = changes[fieldName];
  }
  return saveVersioned(objective);
}

export async function addKeyResult(viewer, objectiveId, input) {
  const objective = await loadManagedObjective(viewer, objectiveId);
  if (objective.status !== OKR_STATUSES.ACTIVE) throw new OkrError(409, 'OBJECTIVE_ARCHIVED', 'The objective is archived');
  const activeCount = await KeyResult.countDocuments({ objectiveId, status: OKR_STATUSES.ACTIVE });
  if (activeCount >= OKR_FIELD_LIMITS.MAX_KEY_RESULTS_PER_OBJECTIVE) {
    throw new OkrError(409, 'TOO_MANY_KEY_RESULTS', `An objective can have at most ${OKR_FIELD_LIMITS.MAX_KEY_RESULTS_PER_OBJECTIVE} key results`);
  }
  await requireOwnerProfile(input.ownerEmployeeId);
  return KeyResult.create({
    objectiveId,
    title: input.title,
    ownerEmployeeId: input.ownerEmployeeId,
    unit: input.unit,
    startValue: input.startValue,
    targetValue: input.targetValue,
    currentValue: input.startValue,
    weight: input.weight,
    milestones: (input.milestones ?? []).map((milestone) => ({ title: milestone.title, dueDate: milestone.dueDate ?? null })),
  });
}

/** Loads a key result the viewer may update (and its objective), at the expected version. */
async function loadUpdatableKeyResult(viewer, keyResultId, expectedVersion) {
  const keyResult = await KeyResult.findById(keyResultId);
  if (!keyResult) throw new OkrError(404, 'KEY_RESULT_NOT_FOUND', 'Key result not found');
  const objective = await Objective.findById(keyResult.objectiveId).lean();
  if (!canUpdateKeyResult(viewer, keyResult, objective)) throw new OkrError(403, 'OKR_FORBIDDEN', 'You cannot update this key result');
  if (keyResult.status !== OKR_STATUSES.ACTIVE || objective.status !== OKR_STATUSES.ACTIVE) throw new OkrError(409, 'KEY_RESULT_ARCHIVED', 'This key result is archived');
  if (expectedVersion !== undefined && keyResult.__v !== expectedVersion) throw new OkrError(409, 'STALE_VERSION', 'This key result was updated by someone else. Reload and try again');
  return keyResult;
}

/** Saves with optimistic concurrency, turning a lost race into 409. */
async function saveVersioned(document) {
  try {
    return await document.save();
  } catch (saveError) {
    if (saveError instanceof mongoose.Error.VersionError) throw new OkrError(409, 'STALE_VERSION', 'This item was changed by someone else. Reload and try again');
    throw saveError;
  }
}

/**
 * Progress slider: sets currentValue directly, or from a percentage of the way from start to target.
 * The value is limited to the start-target range (an over-achievement still shows 100%, but the
 * reported value is kept as given when set directly).
 */
export async function updateKeyResultProgress(viewer, keyResultId, { currentValue, progressPercent, note, version }) {
  const keyResult = await loadUpdatableKeyResult(viewer, keyResultId, version);
  const nextValue = currentValue !== undefined ? currentValue : Math.round((keyResult.startValue + ((keyResult.targetValue - keyResult.startValue) * progressPercent) / 100) * 100) / 100;
  keyResult.currentValue = nextValue;
  keyResult.checkIns.push({ value: nextValue, note: note ?? null, byUserId: viewer.userId, at: new Date() });
  return saveVersioned(keyResult);
}

export async function addMilestone(viewer, keyResultId, { title, dueDate, version }) {
  const keyResult = await loadUpdatableKeyResult(viewer, keyResultId, version);
  if (keyResult.milestones.length >= OKR_FIELD_LIMITS.MAX_MILESTONES_PER_KEY_RESULT) {
    throw new OkrError(409, 'TOO_MANY_MILESTONES', `A key result can have at most ${OKR_FIELD_LIMITS.MAX_MILESTONES_PER_KEY_RESULT} milestones`);
  }
  keyResult.milestones.push({ title, dueDate: dueDate ?? null });
  return saveVersioned(keyResult);
}

export async function updateMilestone(viewer, keyResultId, milestoneId, { status, title, dueDate, version }) {
  const keyResult = await loadUpdatableKeyResult(viewer, keyResultId, version);
  const milestone = keyResult.milestones.id(milestoneId);
  if (!milestone) throw new OkrError(404, 'MILESTONE_NOT_FOUND', 'Milestone not found');
  if (title !== undefined) milestone.title = title;
  if (dueDate !== undefined) milestone.dueDate = dueDate;
  if (status !== undefined && status !== milestone.status) {
    milestone.status = status;
    milestone.completedAt = status === MILESTONE_STATUSES.DONE ? new Date() : null;
    milestone.completedByUserId = status === MILESTONE_STATUSES.DONE ? viewer.userId : null;
  }
  return saveVersioned(keyResult);
}
