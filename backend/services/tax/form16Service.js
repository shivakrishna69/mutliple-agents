/**
 * The Form 16 portal (routes/taxRoutes.js): chartered accountants (MANAGE_FORM16) see the employees
 * whose annual CTC is above the threshold (form16Eligibility.js), their salary structure and the TDS
 * on their payslips, and upload their Form 16; employees (VIEW_OWN_FORM16) see and download their own.
 *
 *   listCaEmployees        eligible employees for a financial year, with their active Form 16 and
 *                          the year's counts (eligible, uploaded, pending)
 *   getCaEmployee          one eligible employee: CTC and its split, the year's TDS, Form 16 history
 *   uploadForm16           store a PDF and its record; an earlier one for the same employee, year and
 *                          part is superseded
 *   getMyForm16            the signed-in employee's own active Form 16 for a year
 *   createForm16Download   a 60-second download link, for the employee or a CA
 *
 * Privacy: an employee at or below the threshold is "not found" to a CA everywhere (404, never 403,
 * so ids cannot be probed), and another employee's Form 16 is "not found" to an employee. Salary and
 * tax figures are never logged; audit events carry ids and outcomes only.
 *
 * Supersession without transactions: the PDF is uploaded first, then the active record is marked
 * superseded by a conditional update (it must still be active), then the new record is inserted;
 * the partial unique index on active records refuses a second active one. If either step loses to
 * an upload at the same moment, the earlier step is undone and the stored PDF removed (409).
 */

import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import { HTTP_STATUS } from '../../constants/httpStatus.js';
import { FORM16_MESSAGES } from '../../constants/messages.js';
import { FORM16_SETTINGS } from '../../constants/validation.js';
import Department from '../../models/Department.js';
import EmployeeProfile from '../../models/EmployeeProfile.js';
import Form16Record, { FORM16_PART_TYPES, FORM16_STATUSES } from '../../models/Form16Record.js';
import OnboardingDraft, { DRAFT_STATUSES } from '../../models/OnboardingDraft.js';
import Payslip, { PAYSLIP_STATUSES } from '../../models/Payslip.js';
import User from '../../models/User.js';
import { isDuplicateKeyError } from '../../utils/mongoErrors.js';
import { escapeRegularExpression } from '../../utils/regularExpressions.js';
import { ServiceError } from '../serviceError.js';
import { eligibleProfileFilter, assessmentYearOf, isForm16EligibleCtc } from './form16Eligibility.js';
import {
  Form16StorageError,
  buildForm16ObjectKey,
  createForm16DownloadUrl,
  form16Store,
  uploadForm16Pdf,
} from './form16Storage.js';

export const FORM16_LIST_STATUSES = Object.freeze({ UPLOADED: 'uploaded', PENDING: 'pending' });

const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');
const TDS_CODE = 'TDS';
const SENT_OFFER_STATUSES = Object.freeze([DRAFT_STATUSES.DISPATCHED, DRAFT_STATUSES.DISPATCH_FAILED]);
const PROFILE_FIELDS =
  'userId employeeCode organizationData.designation organizationData.departmentId organizationData.employmentStatus ' +
  '+compensation.annualCtc +compensation.effectiveFrom +compensation.source';
const PART_FILE_LABELS = Object.freeze({
  [FORM16_PART_TYPES.CONSOLIDATED]: 'Form16',
  [FORM16_PART_TYPES.PART_A]: 'Form16-PartA',
  [FORM16_PART_TYPES.PART_B]: 'Form16-PartB',
});

const notFound = (code, message) => new ServiceError(HTTP_STATUS.NOT_FOUND, code, message);
const employeeNotFound = () => notFound('EMPLOYEE_NOT_FOUND', FORM16_MESSAGES.EMPLOYEE_NOT_FOUND);
const documentNotFound = () => notFound('FORM16_NOT_FOUND', FORM16_MESSAGES.DOCUMENT_NOT_FOUND);
const concurrentUpload = () =>
  new ServiceError(HTTP_STATUS.CONFLICT, 'FORM16_CONCURRENT_UPLOAD', FORM16_MESSAGES.CONCURRENT_UPLOAD);
const storageNotConfigured = () =>
  new ServiceError(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    'FORM16_STORAGE_NOT_CONFIGURED',
    FORM16_MESSAGES.STORAGE_NOT_CONFIGURED,
  );
const storageUnavailable = () =>
  new ServiceError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'FORM16_STORAGE_UNAVAILABLE', FORM16_MESSAGES.STORAGE_UNAVAILABLE);

const toIdString = (id) => (id ? id.toString() : null);

/** True when the bytes are a PDF (they start with "%PDF-"). */
export const isPdfContent = (content) =>
  Buffer.isBuffer(content) && content.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE);

/** A record as the API shows it (no storage key). */
function documentOf(record) {
  const summary = record.computationSummary ?? {};
  return {
    id: record._id.toString(),
    employeeId: record.employeeId.toString(),
    financialYear: record.financialYear,
    assessmentYear: record.assessmentYear,
    partType: record.partType,
    status: record.status,
    version: record.version,
    fileName: record.fileName,
    fileSizeBytes: record.fileSizeBytes,
    sha256Checksum: record.sha256Checksum,
    computationSummary: {
      grossSalary: summary.grossSalary ?? null,
      totalDeductions: summary.totalDeductions ?? null,
      taxableIncome: summary.taxableIncome ?? null,
      totalTaxPayable: summary.totalTaxPayable ?? null,
      tdsDeducted: summary.tdsDeducted ?? null,
      taxRegime: summary.taxRegime ?? null,
      caRemarks: summary.caRemarks ?? null,
    },
    uploadedBy: toIdString(record.uploadedBy),
    uploadedAt: record.uploadedAt,
    supersededAt: record.supersededAt ?? null,
    supersededBy: toIdString(record.supersededBy),
  };
}

/** The employee's name, email, department and CTC, for the CA's list and detail. */
function employeeSummaryOf(profile, account, departmentName) {
  return {
    employeeId: profile._id.toString(),
    employeeCode: profile.employeeCode ?? null,
    name: account?.name ?? 'Unnamed',
    email: account?.companyEmail ?? account?.email ?? null,
    designation: profile.organizationData?.designation ?? null,
    departmentName: departmentName ?? null,
    employmentStatus: profile.organizationData?.employmentStatus ?? null,
    annualCtc: profile.compensation?.annualCtc ?? null,
  };
}

async function departmentNamesById(profiles) {
  const departmentIds = [
    ...new Set(profiles.map((profile) => toIdString(profile.organizationData?.departmentId))),
  ].filter(Boolean);
  if (departmentIds.length === 0) return new Map();
  const departments = await Department.find({ _id: { $in: departmentIds } })
    .select('name')
    .lean();
  return new Map(departments.map((department) => [department._id.toString(), department.name]));
}

/** An eligible employee's profile (lean, with compensation), or 404 for anyone else. */
async function findEligibleProfile(employeeId) {
  if (!mongoose.isValidObjectId(employeeId)) throw employeeNotFound();
  const profile = await EmployeeProfile.findOne({ _id: employeeId, ...eligibleProfileFilter() })
    .select(PROFILE_FIELDS)
    .lean();
  if (!profile) throw employeeNotFound();
  return profile;
}

/** The profile filter for a CA's search: name, email or company email (on the account) or employee ID. */
async function searchFilterOf(search) {
  if (!search) return {};
  const pattern = new RegExp(escapeRegularExpression(search), 'i');
  const accounts = await User.find({ $or: [{ name: pattern }, { email: pattern }, { companyEmail: pattern }] })
    .select('_id')
    .lean();
  return { $or: [{ userId: { $in: accounts.map((account) => account._id) } }, { employeeCode: pattern }] };
}

/**
 * GET /api/tax/ca/employees: the year's counts over every eligible employee, and the eligible
 * employees matching the search and status, each with their active Form 16 documents.
 * @param {{ financialYear: string, search: string|null, status: string|null }} query
 */
export async function listCaEmployees({ financialYear, search, status }) {
  const uploadedEmployeeIds = await Form16Record.distinct('employeeId', {
    financialYear,
    status: FORM16_STATUSES.ACTIVE,
  });
  const [eligibleCount, uploadedCount] = await Promise.all([
    EmployeeProfile.countDocuments(eligibleProfileFilter()),
    EmployeeProfile.countDocuments({ ...eligibleProfileFilter(), _id: { $in: uploadedEmployeeIds } }),
  ]);

  const statusFilter =
    status === FORM16_LIST_STATUSES.UPLOADED
      ? { _id: { $in: uploadedEmployeeIds } }
      : status === FORM16_LIST_STATUSES.PENDING
        ? { _id: { $nin: uploadedEmployeeIds } }
        : {};
  const profileFilter = { $and: [eligibleProfileFilter(), statusFilter, await searchFilterOf(search)] };
  const [matchingCount, profiles] = await Promise.all([
    EmployeeProfile.countDocuments(profileFilter),
    EmployeeProfile.find(profileFilter)
      .select(PROFILE_FIELDS)
      .sort({ employeeCode: 1, _id: 1 })
      .limit(FORM16_SETTINGS.LIST_LIMIT)
      .lean(),
  ]);

  const profileIds = profiles.map((profile) => profile._id);
  const [accounts, departmentNames, activeRecords] = await Promise.all([
    User.find({ _id: { $in: profiles.map((profile) => profile.userId) } })
      .select('name email companyEmail')
      .lean(),
    departmentNamesById(profiles),
    Form16Record.find({ financialYear, status: FORM16_STATUSES.ACTIVE, employeeId: { $in: profileIds } })
      .sort({ partType: 1 })
      .lean(),
  ]);
  const accountByUserId = new Map(accounts.map((account) => [account._id.toString(), account]));
  const documentsByEmployeeId = new Map();
  for (const record of activeRecords) {
    const employeeKey = record.employeeId.toString();
    documentsByEmployeeId.set(employeeKey, [...(documentsByEmployeeId.get(employeeKey) ?? []), documentOf(record)]);
  }

  const employees = profiles
    .map((profile) => {
      const documents = documentsByEmployeeId.get(profile._id.toString()) ?? [];
      return {
        ...employeeSummaryOf(
          profile,
          accountByUserId.get(profile.userId.toString()),
          departmentNames.get(toIdString(profile.organizationData?.departmentId)),
        ),
        form16Status: documents.length > 0 ? FORM16_LIST_STATUSES.UPLOADED : FORM16_LIST_STATUSES.PENDING,
        documents,
      };
    })
    .sort((first, second) => first.name.localeCompare(second.name));

  return {
    financialYear,
    assessmentYear: assessmentYearOf(financialYear),
    summary: { eligible: eligibleCount, uploaded: uploadedCount, pending: eligibleCount - uploadedCount },
    employees,
    matchingCount,
    truncated: matchingCount > employees.length,
  };
}

/**
 * The CTC split from the offer the employee was sent, while their current CTC is still the offer's;
 * null otherwise (hired without an offer, or the CTC has changed since).
 */
async function offerSplitOf(profile) {
  const offer = await OnboardingDraft.findOne({
    'dispatch.employeeUserId': profile.userId,
    status: { $in: SENT_OFFER_STATUSES },
  })
    .sort({ updatedAt: -1 })
    .select('compensation.annualCtc structure')
    .lean();
  const structure = offer?.structure;
  if (!structure?.earnings || offer.compensation.annualCtc !== profile.compensation?.annualCtc) return null;
  const annual = (part) => part?.annual ?? 0;
  return {
    taxRegime: structure.taxRegime ?? null,
    basic: annual(structure.earnings.basic),
    hra: annual(structure.earnings.hra),
    specialAllowance: annual(structure.earnings.specialAllowance),
    gross: annual(structure.earnings.gross),
    employerProvidentFund: annual(structure.employerContributions?.providentFund),
    employerEsi: annual(structure.employerContributions?.esi),
    gratuity: annual(structure.employerContributions?.gratuity),
    variablePay: annual(structure.variablePay),
  };
}

/** The year's issued payslips: gross and TDS per month, and their totals. */
async function taxDeductedOf(employeeId, financialYear) {
  const payslips = await Payslip.find({ employeeId, financialYear, status: PAYSLIP_STATUSES.ISSUED })
    .select('period grossEarnings deductions taxSummary.regime')
    .sort({ 'period.year': 1, 'period.month': 1 })
    .lean();
  const months = payslips.map((payslip) => ({
    period: `${payslip.period.year}-${String(payslip.period.month).padStart(2, '0')}`,
    grossEarnings: payslip.grossEarnings,
    tds: payslip.deductions.filter((line) => line.code === TDS_CODE).reduce((sum, line) => sum + line.amount, 0),
  }));
  return {
    months,
    totals: {
      grossEarnings: months.reduce((sum, month) => sum + month.grossEarnings, 0),
      tds: months.reduce((sum, month) => sum + month.tds, 0),
    },
    taxRegime: payslips.at(-1)?.taxSummary?.regime ?? null,
  };
}

/** GET /api/tax/ca/employees/:employeeId: 404 unless the employee is eligible. */
export async function getCaEmployee({ employeeId, financialYear }) {
  const profile = await findEligibleProfile(employeeId);
  const [account, departmentNames, ctcSplit, taxDeducted, history] = await Promise.all([
    User.findById(profile.userId).select('name email companyEmail').lean(),
    departmentNamesById([profile]),
    offerSplitOf(profile),
    taxDeductedOf(profile._id, financialYear),
    Form16Record.find({ employeeId: profile._id, financialYear }).sort({ version: -1, partType: 1 }).lean(),
  ]);
  return {
    financialYear,
    assessmentYear: assessmentYearOf(financialYear),
    employee: employeeSummaryOf(
      profile,
      account,
      departmentNames.get(toIdString(profile.organizationData?.departmentId)),
    ),
    ctc: {
      annualCtc: profile.compensation.annualCtc,
      effectiveFrom: profile.compensation.effectiveFrom ?? null,
      source: profile.compensation.source ?? null,
      split: ctcSplit,
    },
    taxDeducted,
    history: history.map(documentOf),
  };
}

function safeFileName(originalName) {
  const trimmed = String(originalName ?? '')
    .replace(/[^\w.\- ]+/g, '_')
    .trim()
    .slice(0, 150);
  return trimmed.toLowerCase().endsWith('.pdf') ? trimmed : `${trimmed || 'form16'}.pdf`;
}

/**
 * POST /api/tax/ca/employees/:employeeId/form16
 * @param {{ employeeId: string, financialYear: string, partType: string, computationSummary: object,
 *   file: { buffer: Buffer, originalname: string }, actorUserId: string, requestId: string, now?: Date }} upload
 * @returns {Promise<{ document: object, supersededId: string|null }>}
 */
export async function uploadForm16({
  employeeId,
  financialYear,
  partType,
  computationSummary,
  file,
  actorUserId,
  requestId,
  now = new Date(),
}) {
  if (!form16Store.isConfigured()) throw storageNotConfigured();
  const profile = await findEligibleProfile(employeeId);

  const recordId = new mongoose.Types.ObjectId();
  const s3Key = buildForm16ObjectKey({
    financialYear,
    employeeId: profile._id.toString(),
    recordId: recordId.toString(),
  });
  let stored;
  try {
    stored = await uploadForm16Pdf(Readable.from([file.buffer]), s3Key);
  } catch (storageError) {
    if (storageError instanceof Form16StorageError) throw storageUnavailable();
    throw storageError;
  }

  const partFilter = { employeeId: profile._id, financialYear, partType };
  const [active, latest] = await Promise.all([
    Form16Record.findOne({ ...partFilter, status: FORM16_STATUSES.ACTIVE })
      .select('_id')
      .lean(),
    Form16Record.findOne(partFilter).sort({ version: -1 }).select('version').lean(),
  ]);

  const discardUpload = () => form16Store.deleteQuietly(s3Key, requestId);
  if (active) {
    const superseded = await Form16Record.updateOne(
      { _id: active._id, status: FORM16_STATUSES.ACTIVE },
      { $set: { status: FORM16_STATUSES.SUPERSEDED, supersededAt: now, supersededBy: recordId } },
    );
    if (superseded.modifiedCount === 0) {
      await discardUpload();
      throw concurrentUpload();
    }
  }

  try {
    const record = await Form16Record.create({
      _id: recordId,
      ...partFilter,
      assessmentYear: assessmentYearOf(financialYear),
      computationSummary,
      s3Key,
      fileName: safeFileName(file.originalname),
      fileSizeBytes: stored.sizeBytes,
      sha256Checksum: stored.sha256,
      serverSideEncryption: form16Store.serverSideEncryption(),
      status: FORM16_STATUSES.ACTIVE,
      version: (latest?.version ?? 0) + 1,
      uploadedBy: actorUserId,
      uploadedAt: now,
    });
    return { document: documentOf(record), supersededId: toIdString(active?._id) };
  } catch (createError) {
    if (active) {
      await Form16Record.updateOne(
        { _id: active._id, supersededBy: recordId },
        { $set: { status: FORM16_STATUSES.ACTIVE, supersededAt: null, supersededBy: null } },
      );
    }
    await discardUpload();
    if (isDuplicateKeyError(createError)) throw concurrentUpload();
    throw createError;
  }
}

/** The signed-in person's EmployeeProfile (lean, with CTC), or null. */
const findOwnProfile = (userId) =>
  EmployeeProfile.findOne({ userId }).select('_id employeeCode +compensation.annualCtc').lean();

/**
 * GET /api/tax/my-form16: { eligible: false, documents: [] } at or below the threshold (or without a
 * CTC); otherwise the year's active Form 16 documents (none yet: the CA has not uploaded). `notice`
 * is what the screen tells the employee when there is nothing to download, else null.
 */
export async function getMyForm16({ userId, financialYear }) {
  const base = { financialYear, assessmentYear: assessmentYearOf(financialYear) };
  const profile = await findOwnProfile(userId);
  if (!profile || !isForm16EligibleCtc(profile.compensation?.annualCtc)) {
    return { ...base, eligible: false, documents: [], notice: FORM16_MESSAGES.NOT_ELIGIBLE_NOTICE };
  }
  const records = await Form16Record.find({ employeeId: profile._id, financialYear, status: FORM16_STATUSES.ACTIVE })
    .sort({ partType: 1 })
    .lean();
  return {
    ...base,
    eligible: true,
    documents: records.map(documentOf),
    notice: records.length === 0 ? FORM16_MESSAGES.PENDING_NOTICE(financialYear) : null,
  };
}

/**
 * GET /api/tax/form16/:documentId/download: the employee whose Form 16 it is (while eligible), or
 * someone with MANAGE_FORM16 (while the employee is eligible); 404 for everyone else.
 * @returns {Promise<{ download: { downloadUrl: string, expiresAt: string }, document: object, grantBasis: string }>}
 */
export async function createForm16Download({ documentId, userId, mayManageForm16 }) {
  if (!mongoose.isValidObjectId(documentId)) throw documentNotFound();
  const record = await Form16Record.findById(documentId).select('+s3Key').lean();
  if (!record) throw documentNotFound();
  const employee = await EmployeeProfile.findById(record.employeeId)
    .select('userId employeeCode +compensation.annualCtc')
    .lean();
  if (!employee || !isForm16EligibleCtc(employee.compensation?.annualCtc)) throw documentNotFound();

  const isOwner = employee.userId.toString() === String(userId);
  if (!isOwner && !mayManageForm16) throw documentNotFound();
  if (!form16Store.isConfigured()) throw storageNotConfigured();

  const fileName = `${PART_FILE_LABELS[record.partType]}-${record.financialYear}-${employee.employeeCode ?? 'employee'}-v${record.version}.pdf`;
  let download;
  try {
    download = await createForm16DownloadUrl(record.s3Key, fileName);
  } catch (storageError) {
    if (storageError instanceof Form16StorageError) throw storageUnavailable();
    throw storageError;
  }
  return { download, document: documentOf(record), grantBasis: isOwner ? 'owner' : 'form16_manager' };
}
