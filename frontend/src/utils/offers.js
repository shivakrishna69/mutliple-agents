/**
 * Offer form values and the requests the backend takes (validators/onboardingValidators.js). The
 * form keeps the backend's field names (components inside `components`, terms inside `terms`), so
 * its field errors land on the right inputs; amounts are typed as text and sent as whole numbers.
 */

/** Empty or a whole number as typed ("12,00,000" works); anything else is sent as written, for the backend to refuse. */
function amountOf(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return undefined;
  const digits = trimmed.replace(/[₹,\s]/g, '');
  return /^\d+$/.test(digits) ? Number(digits) : trimmed;
}

const optional = (text) => (String(text ?? '').trim() === '' ? undefined : String(text).trim());

/** A new offer's form, starting from the onboarding options and the company's terms. */
export function emptyOfferForm(options, settings) {
  return {
    name: '',
    email: '',
    dateOfBirth: '',
    gender: '',
    role: options.defaults?.role ?? options.roles?.[0] ?? '',
    designation: '',
    departmentId: options.departments?.[0]?.id ?? '',
    reportingManagerId: '',
    workLocationType: options.workLocationTypes?.[0] ?? '',
    dateOfJoining: '',
    employmentStatus: options.employmentStatuses?.[0] ?? '',
    annualCtc: '',
    taxRegime: 'new',
    workCity: '',
    professionalTaxState: '',
    variablePayAnnual: '',
    esopUnits: '',
    basicAnnual: '',
    hraAnnual: '',
    specialAllowanceAnnual: '',
    probationMonths: String(settings?.offerTerms?.probationMonths ?? ''),
    noticePeriodDays: String(settings?.offerTerms?.noticePeriodDays ?? ''),
    offerValidUntil: '',
  };
}

/** The request for /calculate and /create-draft from the form. */
export function offerRequestFromForm(form) {
  const components = {
    basicAnnual: amountOf(form.basicAnnual),
    hraAnnual: amountOf(form.hraAnnual),
    specialAllowanceAnnual: amountOf(form.specialAllowanceAnnual),
  };
  const terms = {
    probationMonths: amountOf(form.probationMonths),
    noticePeriodDays: amountOf(form.noticePeriodDays),
    offerValidUntil: optional(form.offerValidUntil),
  };
  const anyGiven = (group) => Object.values(group).some((value) => value !== undefined);
  return {
    name: form.name.trim(),
    email: form.email.trim(),
    dateOfBirth: form.dateOfBirth,
    gender: optional(form.gender),
    role: form.role,
    designation: form.designation.trim(),
    departmentId: form.departmentId,
    reportingManagerId: form.reportingManagerId || null,
    workLocationType: form.workLocationType,
    dateOfJoining: form.dateOfJoining,
    employmentStatus: form.employmentStatus,
    annualCtc: amountOf(form.annualCtc),
    taxRegime: form.taxRegime,
    workCity: form.workCity.trim(),
    professionalTaxState: form.professionalTaxState,
    variablePayAnnual: amountOf(form.variablePayAnnual),
    esopUnits: amountOf(form.esopUnits),
    ...(anyGiven(components) ? { components } : {}),
    ...(anyGiven(terms) ? { terms } : {}),
  };
}

/** The same request for a saved draft (to preview its letter as it would be sent). */
export function offerRequestFromDraft(draft) {
  const { candidate, position, compensation, terms } = draft;
  return {
    name: candidate.name,
    email: candidate.personalEmail,
    companyEmail: candidate.companyEmail ?? undefined,
    dateOfBirth: candidate.dateOfBirth,
    gender: candidate.gender ?? undefined,
    role: position.role,
    designation: position.designation,
    departmentId: position.departmentId,
    reportingManagerId: position.reportingManagerId,
    workLocationType: position.workLocationType,
    dateOfJoining: position.dateOfJoining,
    employmentStatus: position.employmentStatus,
    jobLevel: position.jobLevel,
    employmentType: position.employmentType,
    annualCtc: compensation.annualCtc,
    taxRegime: compensation.taxRegime,
    workCity: compensation.workCity,
    professionalTaxState: compensation.professionalTaxState,
    variablePayAnnual: compensation.variablePayAnnual,
    esopUnits: compensation.esopUnits,
    components: compensation.components,
    terms,
  };
}

/** The message for a form field among the backend's field errors (nested fields by their path). */
export function fieldErrorOf(fieldErrors, field) {
  return fieldErrors?.[field] ?? fieldErrors?.[`components.${field}`] ?? fieldErrors?.[`terms.${field}`];
}
