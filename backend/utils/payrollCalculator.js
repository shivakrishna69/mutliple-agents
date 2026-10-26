/**
 * Payroll tax and statutory-deduction calculator for salaried employees in India, Financial Year
 * (tax year) 2026-27, i.e. 1 April 2026 to 31 March 2027.
 *
 * Entry point: computeTaxLiability(salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails)
 * It computes BOTH tax regimes for the same inputs and returns a structured comparison with the
 * cheaper regime, the annual saving, and the take-home pay under each.
 *
 * =================================================================================================
 * LEGAL BASIS (verified for FY 2026-27; see SOURCES at the end of this comment)
 * =================================================================================================
 *
 *   Statute: the Income-tax Act, 2025 governs income of tax year 2026-27 onwards (it replaced the
 *   Income-tax Act, 1961 from 1 April 2026). Section numbers below are given as "new (old)", e.g.
 *   "s.123 (80C)". The Union Budget 2026 made NO change to slabs, rates, standard deduction, rebate,
 *   surcharge or cess for FY 2026-27, so the FY 2025-26 figures continue.
 *
 *   NEW regime (default regime; s.202, formerly s.115BAC)
 *     Slabs on total income:   0-4L nil | 4-8L 5% | 8-12L 10% | 12-16L 15% | 16-20L 20% |
 *                              20-24L 25% | above 24L 30%    (same for every age)
 *     Standard deduction:      ₹75,000 (s.19, formerly s.16(ia))
 *     Rebate (s.156, formerly s.87A): tax up to ₹60,000 if total income ≤ ₹12,00,000, plus
 *                              marginal relief: above ₹12L, tax may not exceed the income above ₹12L.
 *     Allowed deductions:      employer's NPS contribution up to 14% of salary (s.124, formerly
 *                              80CCD(2)). Not allowed: HRA exemption, professional tax, s.123 (80C),
 *                              s.126 (80D), home-loan interest on a self-occupied house, 80E, 80CCD(1B).
 *     Surcharge:               10% above ₹50L, 15% above ₹1Cr, 25% above ₹2Cr (capped at 25%).
 *
 *   OLD regime (opt-in)
 *     Slabs:                   0-2.5L nil | 2.5-5L 5% | 5-10L 20% | above 10L 30%
 *                              Basic exemption ₹3,00,000 for residents aged 60-79 (senior) and
 *                              ₹5,00,000 for 80+ (super senior).
 *     Standard deduction:      ₹50,000 (s.19)
 *     Professional tax:        deductible as paid (s.19, formerly s.16(iii))
 *     HRA exemption:           least of (a) HRA received, (b) rent paid − 10% of salary,
 *                              (c) 50% of salary in the 8 notified cities, 40% elsewhere; "salary" =
 *                              basic + dearness allowance. From FY 2026-27 the Income-tax Rules, 2026
 *                              list 8 cities at 50%: Mumbai, Delhi, Kolkata, Chennai, Bengaluru,
 *                              Hyderabad, Pune, Ahmedabad (formerly only the first four).
 *     Deductions:              s.123 (80C/80CCC/80CCD(1) aggregate) ≤ ₹1,50,000, including the
 *                              employee's own EPF; employee NPS under 80CCD(1) also ≤ 10% of salary;
 *                              s.124 (80CCD(1B)) additional NPS ≤ ₹50,000; s.124 (80CCD(2)) employer
 *                              NPS ≤ 10% of salary; s.126 (80D) health insurance ≤ ₹25,000 self/family
 *                              (₹50,000 if self or spouse is a senior) and ≤ ₹25,000 parents (₹50,000
 *                              if a parent is a senior); s.129 (80E) education-loan interest, no cap;
 *                              s.22 (24(b)) interest on a self-occupied home loan ≤ ₹2,00,000.
 *     Rebate (s.156):          tax up to ₹12,500 if total income ≤ ₹5,00,000 (no marginal relief).
 *     Surcharge:               10% above ₹50L, 15% above ₹1Cr, 25% above ₹2Cr, 37% above ₹5Cr.
 *
 *   Both regimes
 *     Marginal relief on surcharge: crossing a surcharge threshold may not raise tax + surcharge by
 *       more than the income above that threshold.
 *     Health and Education Cess: 4% of (tax + surcharge).
 *     Rounding: total income to the nearest ₹10, and the final tax to the nearest ₹10 (formerly
 *       ss.288A / 288B; the same rounding continues under the 2025 Act).
 *
 *   EPF (Employees' Provident Fund; Code on Social Security, 2020 / EPF Scheme)
 *     Employee contribution: 12% of monthly basic + DA, computed on wages up to the statutory wage
 *       ceiling. The ceiling was ₹15,000 until 16 September 2026 and is ₹25,000 from 17 September
 *       2026 (MoLE notification S.O. 5109(E) dated 17 Sep 2026). September 2026 is split by days:
 *       1-16 Sep at the ₹15,000 ceiling, 17-30 Sep at the ₹25,000 ceiling. An employee may contribute
 *       on full basic above the ceiling (voluntary, `epfContributionOnFullBasic`). Contributions are
 *       rounded to the nearest rupee.
 *
 *   ESI (Employees' State Insurance; Code on Social Security, 2020 / ESI Act)
 *     Coverage: gross monthly wages ≤ ₹21,000 (≤ ₹25,000 for persons with disability). Unchanged.
 *     Employee contribution: 0.75% of gross wages, rounded UP to the next whole rupee. Employees whose
 *       average daily wage is ≤ ₹176 pay no employee share (the employer still contributes).
 *     Contribution periods: April-September and October-March. An employee covered at the start of
 *       a period stays covered for the whole period even if wages rise. This calculator assumes
 *       uniform monthly salary, so coverage is the same for every month.
 *
 *   Professional tax (state levy, constitutional cap ₹2,500 per year; Article 276(2))
 *     Karnataka (from 1 April 2025): nil below ₹25,000 gross per month; ₹200 per month at
 *       ₹25,000 and above, ₹300 in February (₹2,500 a year).
 *     Maharashtra: men: nil up to ₹7,500; ₹175 for ₹7,501-₹10,000; ₹200 above ₹10,000 (₹300 in
 *       February). Women: nil up to ₹25,000; ₹200 above (₹300 in February).
 *     Other states have their own slabs and are not modelled; pass "NONE" only when the employee's
 *       state of work levies no professional tax. An unknown state is rejected rather than guessed.
 *
 * =================================================================================================
 * SCOPE AND ASSUMPTIONS
 * =================================================================================================
 *   - Resident individual with income from salary only. Other income (interest, capital gains,
 *     rent) and deductions tied to it (80TTA/80TTB, 80G donations, loss set-off) are out of scope.
 *   - Salary is paid uniformly across the 12 months of the year.
 *   - Employer contributions (EPF, NPS) are assumed within the ₹7,50,000 aggregate tax-free limit.
 *   - The result is an estimate for planning and payroll TDS projection, not a tax return; the
 *     employee's actual liability depends on all their income and proofs.
 *
 * SOURCES (checked October 2026)
 *   Slabs/rebate/standard deduction unchanged by Budget 2026: cleartax.in/s/income-tax-slabs
 *   2025 Act section mapping (s.123, s.124, s.126, s.129, s.156, s.19, s.22, s.202): taxgarden.in
 *   Surcharge rates: taxmann.com/post/blog/tax-rates-surcharge-cess
 *   Income-tax Rules 2026 notified, 8-city HRA: mondaq.com (Income Tax Rules, 2026 Notified)
 *   EPF ceiling ₹25,000 from 17 Sep 2026 (S.O. 5109(E)), ESI ceiling unchanged: caclubindia.com
 *   Karnataka PT revision from 1 Apr 2025: greythr product update; Maharashtra slabs: cleartax.in
 */

import { SUPPORTED_FINANCIAL_YEAR, TAX_REGIMES } from './payroll/rules.js';
import { computeRegimeTax } from './payroll/incomeTax.js';
import { computeStatutoryDeductions } from './payroll/statutoryDeductions.js';
import { normalizeInputs } from './payroll/inputs.js';

// The public interface is unchanged by the split into ./payroll/: these names are imported from here.
export {
  AGE_CATEGORIES,
  HRA_FIFTY_PERCENT_CITIES,
  PROFESSIONAL_TAX_STATES,
  SUPPORTED_FINANCIAL_YEAR,
  TAX_REGIMES,
} from './payroll/rules.js';
export { PayrollInputError } from './payroll/inputs.js';

// =================================================================================================
// Public API
// =================================================================================================

/**
 * Computes FY 2026-27 income tax under both regimes, plus EPF, professional tax and ESI, and
 * recommends the cheaper regime.
 *
 * @param {object} salaryStructure  Annual amounts in rupees (≤ 2 decimals):
 *   annualGross (required, every cash salary component), annualBasic (required),
 *   annualDearnessAllowance, annualHraReceived, annualEmployerNpsContribution (paid on top of gross)
 * @param {object|null} investmentsDeclared  Annual amounts claimed (old regime unless noted):
 *   section123Investments (80C-type: PPF, ELSS, life insurance, tuition fees, home-loan principal;
 *   EPF is added automatically), employeeNpsContribution, healthInsuranceSelfFamily,
 *   selfOrSpouseIsSenior, healthInsuranceParents, parentIsSenior, educationLoanInterest,
 *   selfOccupiedHomeLoanInterest, annualRentPaid, rentedCity
 * @param {'old'|'new'} taxRegimeChoice  The regime the employee has opted for; both are computed.
 * @param {object} employmentDetails
 *   professionalTaxState ('KA' | 'MH' | 'NONE', required), gender (required for MH),
 *   ageCategory ('below60' default | 'senior' | 'superSenior'), isPersonWithDisability (ESI ceiling),
 *   epfContributionOnFullBasic (voluntary EPF above the ceiling), isEpfMember (default true),
 *   financialYear (default and only supported: '2026-27')
 * @returns {object} analysis payload (see the returned object below)
 * @throws {PayrollInputError} listing every invalid field
 */
export function computeTaxLiability(salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails) {
  const normalizedInputs = normalizeInputs(salaryStructure, investmentsDeclared, taxRegimeChoice, employmentDetails);
  const statutoryDeductions = computeStatutoryDeductions(normalizedInputs);

  const oldRegime = computeRegimeTax(TAX_REGIMES.OLD, normalizedInputs, statutoryDeductions);
  const newRegime = computeRegimeTax(TAX_REGIMES.NEW, normalizedInputs, statutoryDeductions);

  // Ties go to the new regime: it is the default and needs no investment proofs.
  const recommendedRegime = oldRegime.totalTax < newRegime.totalTax ? TAX_REGIMES.OLD : TAX_REGIMES.NEW;
  const annualSaving = Math.abs(oldRegime.totalTax - newRegime.totalTax);
  const chosenRegime = normalizedInputs.regimeChoice;
  const chosenResult = chosenRegime === TAX_REGIMES.OLD ? oldRegime : newRegime;
  const recommendedResult = recommendedRegime === TAX_REGIMES.OLD ? oldRegime : newRegime;

  return {
    financialYear: SUPPORTED_FINANCIAL_YEAR,
    statute: 'Income-tax Act, 2025 (tax year 2026-27)',
    statutoryDeductions,
    regimes: { old: oldRegime, new: newRegime },
    recommendation: {
      recommendedRegime,
      annualTaxUnderRecommended: recommendedResult.totalTax,
      annualSavingVersusOtherRegime: annualSaving,
      reason:
        annualSaving === 0
          ? 'Both regimes give the same tax; the new regime is recommended because it is the default and needs no investment proofs.'
          : `The ${recommendedRegime} regime costs ₹${annualSaving} less in tax for the year.`,
    },
    chosenRegime: {
      regime: chosenRegime,
      annualTax: chosenResult.totalTax,
      isMostTaxEfficient: chosenResult.totalTax <= recommendedResult.totalTax,
      additionalTaxVersusRecommended: chosenResult.totalTax - recommendedResult.totalTax,
    },
    assumptions: [
      'Resident individual; income from salary only.',
      'Salary paid uniformly across the 12 months of FY 2026-27.',
      'Employer EPF/NPS contributions within the ₹7,50,000 aggregate tax-free limit.',
      'Professional tax modelled for Karnataka and Maharashtra only.',
      'Estimate for planning and TDS projection; actual liability depends on all income and proofs.',
    ],
  };
}
