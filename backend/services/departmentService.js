/**
 * Departments (models/Department.js) as HR manages them: list with head counts, add, change,
 * deactivate, and remove a department nothing refers to. Field values are validated by the model;
 * this service owns slugs, clashes and the removal rule.
 */

import mongoose from 'mongoose';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { DEPARTMENT_MESSAGES } from '../constants/messages.js';
import { ORGANIZATION_FIELD_LIMITS } from '../constants/validation.js';
import Department from '../models/Department.js';
import EmployeeInvitation, { INVITATION_STATUSES } from '../models/EmployeeInvitation.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES } from '../models/EmployeeProfile.js';
import Objective from '../models/Objective.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { firstFreeSlug, slugify } from '../utils/slugs.js';
import { assertCurrentVersion, ServiceError, staleVersion } from './serviceError.js';

const SLUG_MAX_LENGTH = ORGANIZATION_FIELD_LIMITS.DEPARTMENT_SLUG_MAX_LENGTH;

const departmentNotFound = () =>
  new ServiceError(HTTP_STATUS.NOT_FOUND, 'DEPARTMENT_NOT_FOUND', DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND);

/** The clash a unique index reported, named by the index's first field. */
function clashError(duplicateKeyError) {
  const clashedField = Object.keys(duplicateKeyError.keyPattern ?? {}).find((field) => field !== 'parentDepartmentId');
  const [code, message] = {
    code: ['DEPARTMENT_CODE_TAKEN', DEPARTMENT_MESSAGES.DEPARTMENT_CODE_TAKEN],
    slug: ['DEPARTMENT_SLUG_TAKEN', DEPARTMENT_MESSAGES.DEPARTMENT_SLUG_TAKEN],
  }[clashedField] ?? ['DEPARTMENT_NAME_TAKEN', DEPARTMENT_MESSAGES.DEPARTMENT_NAME_TAKEN];
  return new ServiceError(HTTP_STATUS.CONFLICT, code, message);
}

async function saveDepartment(department) {
  try {
    await department.save();
  } catch (saveError) {
    if (saveError instanceof mongoose.Error.VersionError) throw staleVersion();
    if (isDuplicateKeyError(saveError)) throw clashError(saveError);
    throw saveError;
  }
}

/** A free slug made from `name` ("Data Science" -> "data-science", or "data-science-2"). */
export function freeSlugFor(name, fallback) {
  return firstFreeSlug(slugify(name, { maxLength: SLUG_MAX_LENGTH, fallback }), {
    maxLength: SLUG_MAX_LENGTH,
    isTaken: (candidate) => Department.exists({ slug: candidate }).then(Boolean),
  });
}

const idOrNull = (id) => id?.toString() ?? null;

export function toDepartmentSummary(department, memberCount = 0) {
  return {
    id: department._id.toString(),
    name: department.name,
    code: department.code,
    slug: department.slug,
    budgetCode: department.budgetCode ?? null,
    parentDepartmentId: idOrNull(department.parentDepartmentId),
    departmentHeadId: idOrNull(department.departmentHeadId),
    isActive: department.isActive !== false,
    isSharedService: department.isSharedService === true,
    memberCount,
    version: department.__v,
  };
}

/** Current employees (not terminated) per department id. */
async function countMembers(departmentIds) {
  const counts = await EmployeeProfile.aggregate([
    {
      $match: {
        'organizationData.departmentId': { $in: departmentIds },
        'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
      },
    },
    { $group: { _id: '$organizationData.departmentId', memberCount: { $sum: 1 } } },
  ]);
  return new Map(counts.map((count) => [count._id.toString(), count.memberCount]));
}

/** Every department by name, with its current head count; inactive ones only when asked for. */
export async function listDepartments({ includeInactive = false } = {}) {
  const departments = await Department.find(includeInactive ? {} : { isActive: { $ne: false } })
    .sort({ name: 1 })
    .lean();
  const memberCounts = await countMembers(departments.map((department) => department._id));
  return departments.map((department) =>
    toDepartmentSummary(department, memberCounts.get(department._id.toString()) ?? 0),
  );
}

export async function getDepartment(departmentId) {
  const department = await Department.findById(departmentId).lean();
  if (!department) throw departmentNotFound();
  const memberCounts = await countMembers([department._id]);
  return toDepartmentSummary(department, memberCounts.get(department._id.toString()) ?? 0);
}

/** A slug sent by HR must be free; without one, a free slug is made from the name. */
export async function createDepartment({ slug, ...fields }) {
  const department = new Department({
    ...fields,
    slug: slug ?? (await freeSlugFor(fields.name ?? '', String(fields.code ?? 'department').toLowerCase())),
  });
  await saveDepartment(department);
  return toDepartmentSummary(department);
}

/** `changes` holds only the fields to change. Renaming keeps the slug, so links keep working. */
export async function updateDepartment({ departmentId, changes, version }) {
  const department = await Department.findById(departmentId);
  if (!department) throw departmentNotFound();
  assertCurrentVersion(department, version);
  department.set(changes);
  await saveDepartment(department);
  return getDepartment(departmentId);
}

/**
 * Removes a department nothing refers to. One with people (current or former), sub-departments,
 * open invitations or objectives is refused: deactivate it instead, so its history stays intact.
 */
export async function deleteDepartment(departmentId) {
  const department = await Department.findById(departmentId);
  if (!department) throw departmentNotFound();
  const references = await Promise.all([
    EmployeeProfile.exists({ 'organizationData.departmentId': department._id }),
    Department.exists({ parentDepartmentId: department._id }),
    EmployeeInvitation.exists({
      'profileDraft.departmentId': department._id,
      status: { $in: [INVITATION_STATUSES.PENDING, INVITATION_STATUSES.ACCEPTING] },
    }),
    Objective.exists({ departmentId: department._id }),
  ]);
  if (references.some(Boolean)) {
    throw new ServiceError(HTTP_STATUS.CONFLICT, 'DEPARTMENT_IN_USE', DEPARTMENT_MESSAGES.DEPARTMENT_IN_USE);
  }
  await department.deleteOne();
  return toDepartmentSummary(department);
}
