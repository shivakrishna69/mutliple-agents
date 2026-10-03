/**
 * Payroll Center (FY rules from GET /api/payroll/rules).
 *
 *   Tax planner   POST /api/payroll/tax-estimate: both regimes side by side, the recommendation,
 *                 statutory deductions (EPF / ESI / professional tax). Nothing is stored.
 *   Payslips      GET /api/payroll/payslips: own payslips (HR/admin: any employee's), with a
 *                 60-second signed download link per PDF.
 *   Issue payslip HR/admin only: POST /api/payroll/payslips, which renders the PDF, stores it
 *                 encrypted and returns the verification ID printed on it.
 *
 * Salary inputs are annual rupee amounts. The compensation form is shared by the planner and the
 * issue form, so both send exactly the structure utils/payrollCalculator.js validates.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { requestPayrollRules, requestPayslipDownload, requestPayslipGeneration, requestPayslipList, requestTaxEstimate, requestWorkforceRisk } from '../api/workforceApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { CheckBadgeIcon, CurrencyIcon, DocumentIcon, DownloadIcon, SparklesIcon } from '../components/Icons.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { Badge, Button, Card, EmptyState, LoadingBlock, MONTH_NAMES, Notice, SelectInput, StatTile, Tabs, TextInput, Toggle, formatBytes, formatDate, formatInr, openSignedUrl } from '../components/ui.jsx';
import { ROUTE_PATHS, USER_ROLES } from '../constants/routes.js';
import { toDisplayError, useApiResource } from '../hooks/useApiResource.js';

const PAYROLL_ADMIN_ROLES = [USER_ROLES.ADMIN, USER_ROLES.HR];

const INITIAL_COMPENSATION = Object.freeze({
  annualGross: '1800000',
  annualBasic: '720000',
  annualDearnessAllowance: '0',
  annualHraReceived: '360000',
  annualEmployerNpsContribution: '0',
  section123Investments: '150000',
  employeeNpsContribution: '0',
  healthInsuranceSelfFamily: '25000',
  selfOrSpouseIsSenior: false,
  healthInsuranceParents: '0',
  parentIsSenior: false,
  educationLoanInterest: '0',
  selfOccupiedHomeLoanInterest: '0',
  annualRentPaid: '300000',
  rentedCity: 'Bengaluru',
  taxRegimeChoice: 'new',
  professionalTaxState: 'KA',
  gender: 'male',
  ageCategory: 'below60',
  isPersonWithDisability: false,
  epfContributionOnFullBasic: false,
  isEpfMember: true,
});

const toAmount = (value) => (value === '' || value === null ? 0 : Number(value));

/** Form state -> the calculator's input shape. */
function buildCompensationPayload(compensation, financialYear) {
  return {
    salaryStructure: {
      annualGross: toAmount(compensation.annualGross),
      annualBasic: toAmount(compensation.annualBasic),
      annualDearnessAllowance: toAmount(compensation.annualDearnessAllowance),
      annualHraReceived: toAmount(compensation.annualHraReceived),
      annualEmployerNpsContribution: toAmount(compensation.annualEmployerNpsContribution),
    },
    investmentsDeclared: {
      section123Investments: toAmount(compensation.section123Investments),
      employeeNpsContribution: toAmount(compensation.employeeNpsContribution),
      healthInsuranceSelfFamily: toAmount(compensation.healthInsuranceSelfFamily),
      selfOrSpouseIsSenior: compensation.selfOrSpouseIsSenior,
      healthInsuranceParents: toAmount(compensation.healthInsuranceParents),
      parentIsSenior: compensation.parentIsSenior,
      educationLoanInterest: toAmount(compensation.educationLoanInterest),
      selfOccupiedHomeLoanInterest: toAmount(compensation.selfOccupiedHomeLoanInterest),
      annualRentPaid: toAmount(compensation.annualRentPaid),
      ...(compensation.rentedCity.trim() && { rentedCity: compensation.rentedCity.trim() }),
    },
    taxRegimeChoice: compensation.taxRegimeChoice,
    employmentDetails: {
      financialYear,
      professionalTaxState: compensation.professionalTaxState,
      ...(compensation.professionalTaxState === 'MH' && { gender: compensation.gender }),
      ageCategory: compensation.ageCategory,
      isPersonWithDisability: compensation.isPersonWithDisability,
      epfContributionOnFullBasic: compensation.epfContributionOnFullBasic,
      isEpfMember: compensation.isEpfMember,
    },
  };
}

/** Field errors from the backend use dotted paths ("salaryStructure.annualBasic"); match by the last segment. */
function fieldErrorFor(fieldErrors, fieldName) {
  const matchingPath = Object.keys(fieldErrors ?? {}).find((fieldPath) => fieldPath === fieldName || fieldPath.endsWith(`.${fieldName}`));
  return matchingPath ? fieldErrors[matchingPath] : undefined;
}

function CompensationForm({ compensation, onChange, rules, fieldErrors }) {
  const update = (fieldName) => (changeEvent) => onChange({ ...compensation, [fieldName]: changeEvent.target.value });
  const amountField = (fieldName, label, hint) => (
    <TextInput key={fieldName} label={label} hint={hint} type="number" min="0" step="1" inputMode="numeric" value={compensation[fieldName]} onChange={update(fieldName)} error={fieldErrorFor(fieldErrors, fieldName)} />
  );
  const toggleField = (fieldName, label, description) => (
    <Toggle key={fieldName} label={label} description={description} checked={compensation[fieldName]} onChange={(checked) => onChange({ ...compensation, [fieldName]: checked })} />
  );

  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="text-sm font-semibold text-slate-900">Salary structure (annual)</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {amountField('annualGross', 'Gross salary', 'Every salary component, before deductions')}
          {amountField('annualBasic', 'Basic')}
          {amountField('annualDearnessAllowance', 'Dearness allowance')}
          {amountField('annualHraReceived', 'HRA received')}
          {amountField('annualEmployerNpsContribution', 'Employer NPS')}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm font-semibold text-slate-900">Declared investments and rent (old regime)</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {amountField('section123Investments', '80C-style investments', 'PPF, ELSS, life insurance…')}
          {amountField('employeeNpsContribution', 'Own NPS contribution')}
          {amountField('healthInsuranceSelfFamily', 'Health insurance: self & family')}
          {amountField('healthInsuranceParents', 'Health insurance: parents')}
          {amountField('educationLoanInterest', 'Education loan interest')}
          {amountField('selfOccupiedHomeLoanInterest', 'Home loan interest')}
          {amountField('annualRentPaid', 'Rent paid')}
          <TextInput label="Rented city" value={compensation.rentedCity} onChange={update('rentedCity')} error={fieldErrorFor(fieldErrors, 'rentedCity')} hint={rules ? `50% HRA cities: ${rules.hraFiftyPercentCities.join(', ')}` : undefined} />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {toggleField('selfOrSpouseIsSenior', 'Self or spouse is a senior citizen')}
          {toggleField('parentIsSenior', 'A parent is a senior citizen')}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm font-semibold text-slate-900">Employment</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SelectInput label="Opted regime" value={compensation.taxRegimeChoice} onChange={update('taxRegimeChoice')} options={[{ value: 'new', label: 'New regime' }, { value: 'old', label: 'Old regime' }]} />
          <SelectInput label="Professional tax state" value={compensation.professionalTaxState} onChange={update('professionalTaxState')} options={[{ value: 'KA', label: 'Karnataka' }, { value: 'MH', label: 'Maharashtra' }, { value: 'NONE', label: 'No professional tax' }]} />
          <SelectInput label="Age" value={compensation.ageCategory} onChange={update('ageCategory')} options={[{ value: 'below60', label: 'Below 60' }, { value: 'senior', label: '60 – 79' }, { value: 'superSenior', label: '80 and above' }]} />
          {compensation.professionalTaxState === 'MH' && (
            <SelectInput label="Gender" value={compensation.gender} onChange={update('gender')} options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} />
          )}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {toggleField('isEpfMember', 'EPF member')}
          {toggleField('epfContributionOnFullBasic', 'EPF on full basic', 'Instead of the statutory wage ceiling')}
          {toggleField('isPersonWithDisability', 'Person with disability', 'Raises the ESI wage ceiling')}
        </div>
      </fieldset>
    </div>
  );
}

// =================================================================================================
// Tax planner
// =================================================================================================

function RegimeColumn({ regimeResult, isRecommended, isChosen }) {
  return (
    <div className={`relative rounded-2xl p-5 ring-1 ${isRecommended ? 'bg-gradient-to-br from-indigo-50 to-violet-50 ring-indigo-300' : 'bg-white ring-slate-200'}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold tracking-wide text-slate-900 uppercase">{regimeResult.regime} regime</h3>
        <div className="flex gap-1.5">
          {isRecommended && <Badge tone="indigo">Recommended</Badge>}
          {isChosen && <Badge tone="slate">Your choice</Badge>}
        </div>
      </div>
      <p className="mt-4 text-3xl font-bold tracking-tight text-slate-900">{formatInr(regimeResult.totalTax)}</p>
      <p className="text-xs text-slate-500">
        annual tax · {regimeResult.effectiveTaxRatePercent}% effective · TDS {formatInr(regimeResult.monthlyTds)}/month
      </p>
      <dl className="mt-5 space-y-2 text-sm">
        {[
          ['Gross salary income', regimeResult.grossSalaryIncome],
          ['HRA exemption', regimeResult.hraExemption?.exemption ?? 0],
          ['Standard deduction', regimeResult.standardDeduction],
          ['Chapter VI-A deductions', regimeResult.totalDeductionsAllowed],
          ['Taxable income', regimeResult.taxableIncome],
          ['Rebate', regimeResult.rebate],
          ['Surcharge', regimeResult.surcharge],
          ['Health & education cess', regimeResult.cess],
        ].map(([lineLabel, lineAmount]) => (
          <div key={lineLabel} className="flex justify-between gap-3">
            <dt className="text-slate-500">{lineLabel}</dt>
            <dd className="font-medium text-slate-800 tabular-nums">{formatInr(lineAmount)}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 rounded-xl bg-white/70 p-3 ring-1 ring-slate-200/70">
        <p className="text-xs text-slate-500">Take-home per month</p>
        <p className="text-lg font-bold text-emerald-700">{formatInr(regimeResult.takeHomeMonthly)}</p>
      </div>
      {regimeResult.slabs?.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-medium text-indigo-700">Slab breakdown</summary>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {regimeResult.slabs.map((slabLine) => (
                <tr key={slabLine.from} className="border-t border-slate-100">
                  <td className="py-1.5 text-slate-500">
                    {formatInr(slabLine.from)} – {formatInr(slabLine.to)}
                  </td>
                  <td className="py-1.5 text-right text-slate-500">{slabLine.ratePercent}%</td>
                  <td className="py-1.5 text-right font-medium text-slate-800 tabular-nums">{formatInr(slabLine.tax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function TaxPlanner({ rules }) {
  const { csrfToken } = useAuth();
  const [compensation, setCompensation] = useState(INITIAL_COMPENSATION);
  const [estimate, setEstimate] = useState(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [estimateError, setEstimateError] = useState(null);

  async function handleCalculate(submitEvent) {
    submitEvent.preventDefault();
    setIsCalculating(true);
    setEstimateError(null);
    try {
      const { estimate: calculatedEstimate } = await requestTaxEstimate(buildCompensationPayload(compensation, rules.financialYear), csrfToken);
      setEstimate(calculatedEstimate);
    } catch (calculationError) {
      setEstimateError(toDisplayError(calculationError));
    } finally {
      setIsCalculating(false);
    }
  }

  const recommendedRegime = estimate?.recommendation.recommendedRegime;
  return (
    <div className="grid gap-6 xl:grid-cols-5">
      <Card title={`Your compensation · FY ${rules.financialYear}`} subtitle="Figures stay in your browser and the calculation request; nothing is saved." className="xl:col-span-3">
        <form onSubmit={handleCalculate} className="space-y-6">
          <CompensationForm compensation={compensation} onChange={setCompensation} rules={rules} fieldErrors={estimateError?.fieldErrors} />
          {estimateError && <Notice tone="error" title={estimateError.message} onDismiss={() => setEstimateError(null)} />}
          <div className="flex justify-end">
            <Button type="submit" isBusy={isCalculating}>
              <SparklesIcon className="h-4 w-4" /> Compare regimes
            </Button>
          </div>
        </form>
      </Card>
      <div className="space-y-4 xl:col-span-2">
        {!estimate && <EmptyState Icon={CurrencyIcon} title="Compare both regimes" description="Enter your salary and declarations, and see which regime leaves you with more." />}
        {estimate && (
          <>
            <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 p-5 text-white shadow-lg shadow-indigo-600/20">
              <p className="text-xs font-semibold tracking-wide text-indigo-100 uppercase">Recommendation</p>
              <p className="mt-2 text-xl font-bold">{recommendedRegime === 'new' ? 'New' : 'Old'} regime saves {formatInr(estimate.recommendation.annualSavingVersusOtherRegime)}</p>
              <p className="mt-1 text-sm text-indigo-100">{estimate.recommendation.reason}</p>
              {!estimate.chosenRegime.isMostTaxEfficient && (
                <p className="mt-3 rounded-lg bg-white/15 px-3 py-2 text-sm">Your opted regime costs {formatInr(estimate.chosenRegime.additionalTaxVersusRecommended)} more this year.</p>
              )}
            </div>
            <RegimeColumn regimeResult={estimate.regimes.new} isRecommended={recommendedRegime === 'new'} isChosen={estimate.chosenRegime.regime === 'new'} />
            <RegimeColumn regimeResult={estimate.regimes.old} isRecommended={recommendedRegime === 'old'} isChosen={estimate.chosenRegime.regime === 'old'} />
            <Card title="Statutory deductions (annual)">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">EPF (employee {estimate.statutoryDeductions.epf.ratePercent}%)</dt>
                  <dd className="font-medium tabular-nums">{formatInr(estimate.statutoryDeductions.epf.annualEmployeeContribution)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">ESI {estimate.statutoryDeductions.esi.isCovered ? `(${estimate.statutoryDeductions.esi.ratePercent}%)` : '(not covered)'}</dt>
                  <dd className="font-medium tabular-nums">{formatInr(estimate.statutoryDeductions.esi.annualEmployeeContribution)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Professional tax ({estimate.statutoryDeductions.professionalTax.state})</dt>
                  <dd className="font-medium tabular-nums">{formatInr(estimate.statutoryDeductions.professionalTax.annualAmount)}</dd>
                </div>
                <div className="flex justify-between border-t border-slate-100 pt-2 font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{formatInr(estimate.statutoryDeductions.annualTotal)}</dd>
                </div>
              </dl>
            </Card>
            {estimate.assumptions?.length > 0 && (
              <details className="rounded-2xl bg-white p-4 text-xs text-slate-600 ring-1 ring-slate-200/70">
                <summary className="cursor-pointer text-sm font-medium text-slate-800">Assumptions</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {estimate.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// =================================================================================================
// Payslips
// =================================================================================================

function PayslipRow({ payslip }) {
  const [isOpening, setIsOpening] = useState(false);
  const [openError, setOpenError] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);

  async function handleDownload() {
    setIsOpening(true);
    setOpenError(null);
    try {
      const downloadData = await requestPayslipDownload(payslip.id);
      openSignedUrl(downloadData.download?.url ?? downloadData.url);
    } catch (downloadError) {
      setOpenError(toDisplayError(downloadError));
    } finally {
      setIsOpening(false);
    }
  }

  return (
    <li className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70">
      <div className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
        <span className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white">
          <span className="text-[0.65rem] font-semibold uppercase">{MONTH_NAMES[payslip.period.month - 1].slice(0, 3)}</span>
          <span className="text-sm font-bold">{payslip.period.year}</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">
            {MONTH_NAMES[payslip.period.month - 1]} {payslip.period.year}
            {payslip.revision > 1 && <span className="ml-2 text-xs font-normal text-slate-500">revision {payslip.revision}</span>}
          </p>
          <p className="truncate text-xs text-slate-500">
            {payslip.employee?.name} · {payslip.verificationId}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-slate-900 tabular-nums">{formatInr(payslip.netPay)}</p>
          <p className="text-xs text-slate-500">net pay</p>
        </div>
        <Badge tone={payslip.status === 'Issued' ? 'emerald' : 'slate'}>{payslip.status}</Badge>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setIsExpanded((wasExpanded) => !wasExpanded)} aria-expanded={isExpanded}>
            Details
          </Button>
          <Button variant="secondary" size="sm" isBusy={isOpening} onClick={handleDownload}>
            <DownloadIcon className="h-4 w-4" /> PDF
          </Button>
        </div>
      </div>
      {openError && (
        <div className="px-5 pb-4">
          <Notice tone="error" title={openError.message} onDismiss={() => setOpenError(null)} />
        </div>
      )}
      {isExpanded && (
        <div className="grid gap-6 border-t border-slate-100 p-5 sm:grid-cols-2">
          {[
            ['Earnings', payslip.earnings, payslip.grossEarnings],
            ['Deductions', payslip.deductions, payslip.totalDeductions],
          ].map(([sectionTitle, lineItems, sectionTotal]) => (
            <div key={sectionTitle}>
              <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{sectionTitle}</p>
              <dl className="mt-2 space-y-1.5 text-sm">
                {lineItems.map((lineItem) => (
                  <div key={lineItem.code} className="flex justify-between gap-3">
                    <dt className="text-slate-600" title={lineItem.reference ?? undefined}>
                      {lineItem.label}
                    </dt>
                    <dd className="font-medium tabular-nums">{formatInr(lineItem.amount, { precise: true })}</dd>
                  </div>
                ))}
                <div className="flex justify-between border-t border-slate-100 pt-1.5 font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{formatInr(sectionTotal, { precise: true })}</dd>
                </div>
              </dl>
            </div>
          ))}
          <p className="text-xs text-slate-500 sm:col-span-2">
            {payslip.netPayInWords} · {payslip.taxSummary.regime} regime · issued {formatDate(payslip.issuedAt)} · PDF {formatBytes(payslip.document.sizeBytes)}
          </p>
        </div>
      )}
    </li>
  );
}

function PayslipLibrary({ isPayrollAdmin, employeeOptions }) {
  const [employeeId, setEmployeeId] = useState('');
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const { data, error, isLoading } = useApiResource((signal) => requestPayslipList({ employeeId: employeeId || undefined, includeSuperseded: includeSuperseded || undefined }, signal), [employeeId, includeSuperseded]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        {isPayrollAdmin && employeeOptions.length > 0 && (
          <SelectInput label="Employee" value={employeeId} onChange={(changeEvent) => setEmployeeId(changeEvent.target.value)} options={[{ value: '', label: 'My payslips' }, ...employeeOptions]} className="w-72" />
        )}
        <div className="w-72">
          <Toggle label="Show superseded revisions" checked={includeSuperseded} onChange={setIncludeSuperseded} />
        </div>
      </div>
      {isLoading && !data && <LoadingBlock label="Loading payslips…" />}
      {error && <Notice tone={error.status === 404 ? 'info' : 'error'} title={error.status === 404 ? 'No employee profile is linked to your account.' : error.message} />}
      {data && (data.payslips ?? []).length === 0 && <EmptyState Icon={DocumentIcon} title="No payslips yet" description="Payslips appear here as soon as payroll issues them." />}
      <ul className="space-y-3">
        {(data?.payslips ?? []).map((payslip) => (
          <PayslipRow key={payslip.id} payslip={payslip} />
        ))}
      </ul>
    </div>
  );
}

// =================================================================================================
// Issue payslip (HR / admin)
// =================================================================================================

function IssuePayslip({ rules, employeeOptions }) {
  const { csrfToken } = useAuth();
  const today = new Date();
  const [employeeId, setEmployeeId] = useState(employeeOptions[0]?.value ?? '');
  const [period, setPeriod] = useState({ year: String(today.getFullYear()), month: String(today.getMonth() + 1) });
  const [compensation, setCompensation] = useState(INITIAL_COMPENSATION);
  const [reissue, setReissue] = useState(false);
  const [isIssuing, setIsIssuing] = useState(false);
  const [issueError, setIssueError] = useState(null);
  const [issuedPayslip, setIssuedPayslip] = useState(null);

  async function handleIssue(submitEvent) {
    submitEvent.preventDefault();
    setIsIssuing(true);
    setIssueError(null);
    setIssuedPayslip(null);
    try {
      const { payslip } = await requestPayslipGeneration(
        { employeeId, year: Number(period.year), month: Number(period.month), reissue, ...buildCompensationPayload(compensation, rules.financialYear) },
        csrfToken,
      );
      setIssuedPayslip(payslip);
    } catch (generationError) {
      setIssueError(toDisplayError(generationError));
    } finally {
      setIsIssuing(false);
    }
  }

  if (employeeOptions.length === 0) {
    return <EmptyState Icon={DocumentIcon} title="No employees found" description="Employee profiles appear here once HR creates them." />;
  }
  return (
    <Card title="Issue a payslip" subtitle="Renders a signed PDF, stores it encrypted and makes it available to the employee.">
      <form onSubmit={handleIssue} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectInput label="Employee" value={employeeId} onChange={(changeEvent) => setEmployeeId(changeEvent.target.value)} options={employeeOptions} />
          <SelectInput label="Month" value={period.month} onChange={(changeEvent) => setPeriod({ ...period, month: changeEvent.target.value })} options={MONTH_NAMES.map((monthName, monthIndex) => ({ value: String(monthIndex + 1), label: monthName }))} />
          <TextInput label="Year" type="number" value={period.year} onChange={(changeEvent) => setPeriod({ ...period, year: changeEvent.target.value })} />
        </div>
        <CompensationForm compensation={compensation} onChange={setCompensation} rules={rules} fieldErrors={issueError?.fieldErrors} />
        <Toggle label="Reissue" description="Replace an already issued payslip for this month with a new revision" checked={reissue} onChange={setReissue} />
        {issueError && <Notice tone="error" title={issueError.message} onDismiss={() => setIssueError(null)} />}
        {issuedPayslip && (
          <Notice tone="success" title={`Payslip issued: net pay ${formatInr(issuedPayslip.netPay)}`}>
            Verification ID <span className="font-mono">{issuedPayslip.verificationId}</span> ·{' '}
            <Link className="font-semibold underline" to={`${ROUTE_PATHS.VERIFY_PAYSLIP}?id=${encodeURIComponent(issuedPayslip.verificationId)}`}>
              verify
            </Link>
          </Notice>
        )}
        <div className="flex justify-end">
          <Button type="submit" isBusy={isIssuing} disabled={!employeeId}>
            <CheckBadgeIcon className="h-4 w-4" /> Generate payslip
          </Button>
        </div>
      </form>
    </Card>
  );
}

// =================================================================================================
// Page
// =================================================================================================

export default function PayrollCenter() {
  const { currentUser } = useAuth();
  const isPayrollAdmin = PAYROLL_ADMIN_ROLES.includes(currentUser.role);
  const [activeTabId, setActiveTabId] = useState('planner');
  const rulesResource = useApiResource((signal) => requestPayrollRules(signal), []);
  // HR and admins pick employees from the workforce roster (the risk report lists every current employee).
  const rosterResource = useApiResource((signal) => requestWorkforceRisk({ limit: 500 }, signal), [], { enabled: isPayrollAdmin });
  const employeeOptions = useMemo(
    () => [...(rosterResource.data?.employees ?? [])].sort((first, second) => (first.name ?? '').localeCompare(second.name ?? '')).map((employee) => ({ value: employee.employeeId, label: `${employee.name ?? 'Unnamed'} · ${employee.designation ?? ''}` })),
    [rosterResource.data],
  );

  const tabs = [
    { id: 'planner', label: 'Tax planner', Icon: CurrencyIcon },
    { id: 'payslips', label: 'Payslips', Icon: DocumentIcon },
    ...(isPayrollAdmin ? [{ id: 'issue', label: 'Issue payslip', Icon: CheckBadgeIcon }] : []),
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8">
      <PageHeader
        title="Payroll"
        description="Plan your taxes, download payslips and verify their authenticity."
        actions={
          <Link to={ROUTE_PATHS.VERIFY_PAYSLIP} className="text-sm font-semibold text-indigo-600 hover:text-indigo-500">
            Verify a payslip →
          </Link>
        }
      />
      {rulesResource.data && (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile label="Financial year" value={rulesResource.data.financialYear} hint="Income-tax Act 2025 rates" Icon={CurrencyIcon} accent="indigo" />
          <StatTile label="Regimes compared" value="Old vs New" hint="Recommendation on every estimate" Icon={SparklesIcon} accent="emerald" />
          <StatTile label="Payslips" value="Signed PDFs" hint="Tamper-evident verification ID" Icon={CheckBadgeIcon} accent="amber" />
        </div>
      )}
      <Tabs tabs={tabs} activeTabId={activeTabId} onChange={setActiveTabId} label="Payroll tools" />
      {rulesResource.isLoading && <LoadingBlock label="Loading payroll rules…" />}
      {rulesResource.error && <Notice tone="error" title={rulesResource.error.message} />}
      {rulesResource.data && activeTabId === 'planner' && <TaxPlanner rules={rulesResource.data} />}
      {activeTabId === 'payslips' && <PayslipLibrary isPayrollAdmin={isPayrollAdmin} employeeOptions={employeeOptions} />}
      {rulesResource.data && activeTabId === 'issue' && isPayrollAdmin && (rosterResource.isLoading ? <LoadingBlock /> : <IssuePayslip rules={rulesResource.data} employeeOptions={employeeOptions} />)}
    </div>
  );
}
