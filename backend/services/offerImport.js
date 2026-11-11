/**
 * Offers from a CSV (POST /api/hr/onboarding/drafts/import): every row becomes an offer draft waiting
 * for review (PENDING_REVIEW), exactly as POST /create-draft would make it. Nothing is sent and
 * nobody is invited: HR reviews the drafts and sends them, one by one or as a batch.
 *
 * One set of rules: each row is turned into the request a single offer takes and checked by the same
 * validator (validators/onboardingValidators.js validateOfferInput) and the same salary structure
 * (onboardingService.draftFieldsFor: a split that does not add up is refused with the same words).
 * What a file adds is checked here: the department by its code and the manager by their email (both
 * must exist), the same personal email twice in the file, emails that already have an account or an
 * open offer, and roles the importer may not give.
 *
 * All or nothing: when any row has a problem, no draft is created and every problem is returned as
 * { line, field (the column), message }, so the corrected file can simply be uploaded again.
 *
 *   OFFER_CSV          the columns (services/employeeImportParser.js reads the file)
 *   rowToOfferRequest  a row's cells as the request a single offer takes (pure)
 *   importOfferDrafts  checks every row and saves the drafts, or returns the problems
 */

import { EMPLOYMENT_TYPE_DEFINITIONS, JOB_LEVEL_DEFINITIONS } from '../constants/accessRoles.js';
import { GENDERS, ONBOARDING_SETTINGS } from '../constants/validation.js';
import Department from '../models/Department.js';
import EmployeeProfile, { EMPLOYMENT_STATUSES, WORK_LOCATION_TYPES } from '../models/EmployeeProfile.js';
import OnboardingDraft, { DRAFT_STATUSES } from '../models/OnboardingDraft.js';
import User from '../models/User.js';
import { PROFESSIONAL_TAX_STATES, TAX_REGIMES } from '../utils/payroll/rules.js';
import { validateOfferInput } from '../validators/onboardingValidators.js';
import { EMPLOYEE_COLUMN_ALIASES, IMPORT_COLUMNS, parseImportCsv } from './employeeImportParser.js';
import { IMPORT_ROLE_VALUES, choiceOf, matchChoice } from './employeeImportValidation.js';
import { invitableRolesFor } from './invitationService.js';
import { draftFieldsFor, getOnboardingSettings, saveDrafts } from './onboardingService.js';
import { ServiceError } from './serviceError.js';

const EMPLOYEE_COLUMNS_USED = Object.freeze([
  'name',
  'personal_email',
  'company_email',
  'department_code',
  'designation',
  'role',
  'manager_email',
  'date_of_joining',
  'work_type',
  'employment_status',
  'job_level',
  'employment_type',
]);

/** The offer CSV: the employee columns an offer needs, then the candidate's and the compensation. */
export const OFFER_IMPORT_COLUMNS = Object.freeze([
  ...IMPORT_COLUMNS.filter((column) => EMPLOYEE_COLUMNS_USED.includes(column.name)),
  Object.freeze({ name: 'date_of_birth', required: true }),
  Object.freeze({ name: 'gender', required: false }),
  Object.freeze({ name: 'ctc', required: true }),
  Object.freeze({ name: 'work_city', required: true }),
  Object.freeze({ name: 'professional_tax_state', required: true }),
  Object.freeze({ name: 'tax_regime', required: false }),
  Object.freeze({ name: 'fixed_base', required: false }),
  Object.freeze({ name: 'hra', required: false }),
  Object.freeze({ name: 'special_allowance', required: false }),
  Object.freeze({ name: 'variable_pay', required: false }),
  Object.freeze({ name: 'esop_units', required: false }),
  Object.freeze({ name: 'probation_months', required: false }),
  Object.freeze({ name: 'notice_period_days', required: false }),
  Object.freeze({ name: 'offer_valid_until', required: false }),
]);

export const OFFER_CSV = Object.freeze({
  columns: OFFER_IMPORT_COLUMNS,
  aliases: Object.freeze({
    ...EMPLOYEE_COLUMN_ALIASES,
    annual_ctc: 'ctc',
    basic: 'fixed_base',
    basic_salary: 'fixed_base',
    dob: 'date_of_birth',
    birth_date: 'date_of_birth',
    city: 'work_city',
    pt_state: 'professional_tax_state',
    variable: 'variable_pay',
    performance_bonus: 'variable_pay',
    esops: 'esop_units',
    probation: 'probation_months',
    notice_period: 'notice_period_days',
    offer_deadline: 'offer_valid_until',
  }),
  maxRows: ONBOARDING_SETTINGS.IMPORT_MAX_ROWS,
});

/** Which column a field of the offer request comes from, for the problems a row has. */
const COLUMN_OF_FIELD = Object.freeze({
  name: 'name',
  email: 'personal_email',
  companyEmail: 'company_email',
  role: 'role',
  designation: 'designation',
  departmentId: 'department_code',
  reportingManagerId: 'manager_email',
  workLocationType: 'work_type',
  dateOfJoining: 'date_of_joining',
  employmentStatus: 'employment_status',
  jobLevel: 'job_level',
  employmentType: 'employment_type',
  dateOfBirth: 'date_of_birth',
  gender: 'gender',
  annualCtc: 'ctc',
  taxRegime: 'tax_regime',
  workCity: 'work_city',
  professionalTaxState: 'professional_tax_state',
  variablePayAnnual: 'variable_pay',
  esopUnits: 'esop_units',
  'components.basicAnnual': 'fixed_base',
  'components.hraAnnual': 'hra',
  'components.specialAllowanceAnnual': 'special_allowance',
  'terms.probationMonths': 'probation_months',
  'terms.noticePeriodDays': 'notice_period_days',
  'terms.offerValidUntil': 'offer_valid_until',
});
/** The column a salary-structure refusal is about. */
const COLUMN_OF_STRUCTURE_CODE = Object.freeze({
  CTC_TOO_LOW: 'ctc',
  SPLIT_EXCEEDS_GROSS: 'fixed_base',
  SPLIT_DOES_NOT_ADD_UP: 'special_allowance',
  PAYROLL_INPUT_INVALID: 'professional_tax_state',
});
const OPEN_DRAFT_STATUSES = Object.freeze([
  DRAFT_STATUSES.PENDING_REVIEW,
  DRAFT_STATUSES.DISPATCHING,
  DRAFT_STATUSES.DISPATCH_FAILED,
]);

/** "25,00,000", "₹ 2,50,000" -> 2500000; empty -> undefined; anything else as written (the validator refuses it). */
function amountOf(cell) {
  if (cell === '') return undefined;
  const digits = cell.replace(/[₹,\s]/g, '');
  return /^\d+$/.test(digits) ? Number(digits) : cell;
}

/** A choice matched loosely (case, spaces, hyphens); empty -> undefined; unknown -> as written. */
const choice = (cell, values) => (cell === '' ? undefined : (matchChoice(cell, values) ?? cell));
const definedChoice = (cell, definitions) => (cell === '' ? undefined : (choiceOf(cell, definitions) ?? cell));

/**
 * A row's cells as the request a single offer takes (pure). The department and manager are looked
 * up by the caller and passed as ids (undefined when not found).
 * @param {Record<string, string>} cells  by column, as the parser gives them
 * @param {{ departmentId?: string, reportingManagerId?: string|null }} references
 */
export function rowToOfferRequest(cells, { departmentId, reportingManagerId = null }) {
  const cell = (column) => (cells[column] ?? '').trim();
  const optional = (value) => (value === '' ? undefined : value);
  const components = {
    basicAnnual: amountOf(cell('fixed_base')),
    hraAnnual: amountOf(cell('hra')),
    specialAllowanceAnnual: amountOf(cell('special_allowance')),
  };
  const terms = {
    probationMonths: amountOf(cell('probation_months')),
    noticePeriodDays: amountOf(cell('notice_period_days')),
    offerValidUntil: optional(cell('offer_valid_until')),
  };
  return {
    name: cell('name'),
    email: cell('personal_email'),
    companyEmail: optional(cell('company_email')),
    role: cell('role') ? (IMPORT_ROLE_VALUES[cell('role').toLowerCase()] ?? cell('role')) : undefined,
    designation: cell('designation'),
    departmentId,
    reportingManagerId,
    workLocationType: choice(cell('work_type'), Object.values(WORK_LOCATION_TYPES)) ?? WORK_LOCATION_TYPES.ONSITE,
    dateOfJoining: cell('date_of_joining'),
    employmentStatus:
      choice(cell('employment_status'), Object.values(EMPLOYMENT_STATUSES)) ?? EMPLOYMENT_STATUSES.PROBATION,
    jobLevel: definedChoice(cell('job_level'), JOB_LEVEL_DEFINITIONS),
    employmentType: definedChoice(cell('employment_type'), EMPLOYMENT_TYPE_DEFINITIONS),
    dateOfBirth: cell('date_of_birth'),
    gender: choice(cell('gender'), Object.values(GENDERS)),
    annualCtc: amountOf(cell('ctc')),
    taxRegime: choice(cell('tax_regime'), Object.values(TAX_REGIMES)),
    workCity: cell('work_city'),
    professionalTaxState: choice(cell('professional_tax_state'), Object.values(PROFESSIONAL_TAX_STATES)),
    variablePayAnnual: amountOf(cell('variable_pay')),
    esopUnits: amountOf(cell('esop_units')),
    components: Object.values(components).some((value) => value !== undefined) ? components : undefined,
    terms: Object.values(terms).some((value) => value !== undefined) ? terms : undefined,
  };
}

/** Active departments by code, and current employees (their profile ids) by account email. */
async function loadReferences(rows) {
  const codes = [...new Set(rows.map((row) => (row.values.department_code ?? '').trim().toUpperCase()))];
  const managerEmails = [
    ...new Set(rows.map((row) => (row.values.manager_email ?? '').trim().toLowerCase()).filter(Boolean)),
  ];
  const [departments, managerAccounts] = await Promise.all([
    Department.find({ code: { $in: codes }, isActive: { $ne: false } })
      .select('code')
      .lean(),
    User.find({ email: { $in: managerEmails } })
      .select('email')
      .lean(),
  ]);
  const managerProfiles = await EmployeeProfile.find({
    userId: { $in: managerAccounts.map((account) => account._id) },
    'organizationData.employmentStatus': { $ne: EMPLOYMENT_STATUSES.TERMINATED },
  })
    .select('userId')
    .lean();
  const emailByUserId = new Map(managerAccounts.map((account) => [account._id.toString(), account.email]));
  return {
    departmentIdByCode: new Map(departments.map((department) => [department.code, department._id.toString()])),
    managerIdByEmail: new Map(
      managerProfiles.map((profile) => [emailByUserId.get(profile.userId.toString()), profile._id.toString()]),
    ),
  };
}

/** Personal emails that already have an account, and those with an offer not yet settled. */
async function loadTakenEmails(emails) {
  const [accounts, openDrafts] = await Promise.all([
    User.find({ email: { $in: emails } })
      .select('email')
      .lean(),
    OnboardingDraft.find({ 'candidate.personalEmail': { $in: emails }, status: { $in: OPEN_DRAFT_STATUSES } })
      .select('candidate.personalEmail')
      .lean(),
  ]);
  return {
    withAccount: new Set(accounts.map((account) => account.email)),
    withOpenOffer: new Set(openDrafts.map((draft) => draft.candidate.personalEmail)),
  };
}

/**
 * @param {Buffer} fileBuffer
 * @param {{ importer: { id: string, role: string }, now?: Date }} context
 * @returns {Promise<{ drafts: object[], ignoredColumns: string[] }
 *   | { problems: { line: number, field: string, message: string }[], ignoredColumns: string[] }>}
 * @throws {ServiceError} 400 for a file that cannot be read (services/employeeImportParser.js)
 */
export async function importOfferDrafts(fileBuffer, { importer, now = new Date() }) {
  const { rows, ignoredColumns } = await parseImportCsv(fileBuffer, OFFER_CSV);
  const [settings, references] = await Promise.all([getOnboardingSettings(), loadReferences(rows)]);
  const allowedRoles = invitableRolesFor(importer.role);
  const problems = [];
  const prepared = [];
  const firstLineByEmail = new Map();

  for (const { rowNumber: line, values } of rows) {
    const rowProblems = [];
    const problem = (field, message) => rowProblems.push({ line, field, message });
    const code = (values.department_code ?? '').trim().toUpperCase();
    const managerEmail = (values.manager_email ?? '').trim().toLowerCase();
    const departmentId = references.departmentIdByCode.get(code);
    const reportingManagerId = managerEmail ? (references.managerIdByEmail.get(managerEmail) ?? undefined) : null;
    if (code && !departmentId) problem('department_code', 'no active department has this code');
    if (managerEmail && !reportingManagerId) problem('manager_email', 'is not the email of a current employee');

    const request = rowToOfferRequest(values, { departmentId, reportingManagerId });
    const validation = validateOfferInput(request, { now });
    for (const { field, message } of validation.isValid ? [] : validation.validationErrors) {
      const column = COLUMN_OF_FIELD[field] ?? field;
      // A department or manager not found is reported once, above.
      if (rowProblems.some((existing) => existing.field === column)) continue;
      problem(column, message);
    }
    if (validation.isValid && !allowedRoles.includes(validation.sanitizedInput.position.role)) {
      problem('role', `you cannot offer the ${validation.sanitizedInput.position.role} role`);
    }
    const email = validation.isValid ? validation.sanitizedInput.candidate.personalEmail : null;
    if (email && firstLineByEmail.has(email)) {
      problem('personal_email', `appears again (line ${firstLineByEmail.get(email)})`);
    } else if (email) {
      firstLineByEmail.set(email, line);
    }
    if (validation.isValid && rowProblems.length === 0) {
      try {
        prepared.push({ line, email, fields: draftFieldsFor(validation.sanitizedInput, settings) });
      } catch (structureError) {
        if (!(structureError instanceof ServiceError)) throw structureError;
        problem(COLUMN_OF_STRUCTURE_CODE[structureError.code] ?? 'ctc', structureError.message);
      }
    }
    problems.push(...rowProblems);
  }

  const taken = await loadTakenEmails(prepared.map((row) => row.email));
  for (const { line, email } of prepared) {
    if (taken.withAccount.has(email)) {
      problems.push({ line, field: 'personal_email', message: 'someone with this email already has an account' });
    } else if (taken.withOpenOffer.has(email)) {
      problems.push({ line, field: 'personal_email', message: 'already has an offer that is not settled' });
    }
  }
  if (problems.length > 0) {
    return { problems: problems.sort((first, second) => first.line - second.line), ignoredColumns };
  }
  return {
    drafts: await saveDrafts(
      prepared.map((row) => row.fields),
      importer.id,
    ),
    ignoredColumns,
  };
}
