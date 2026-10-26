/**
 * Rounding and slab arithmetic shared by the payroll calculator.
 */

// =================================================================================================
// Arithmetic helpers
// =================================================================================================

/** amount × rate, with the rate in basis points; rounded to the paisa. */
export function applyRate(amount, rateBasisPoints) {
  return roundToPaisa((amount * rateBasisPoints) / 10_000);
}

export function roundToPaisa(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Nearest multiple of ₹10; exactly ₹5 rounds up (rounding of total income and of tax). */
export function roundToNearestTen(amount) {
  return Math.floor((amount + 5) / 10) * 10;
}

export function roundToNearestRupee(amount) {
  return Math.round(amount + Number.EPSILON);
}

/** ESI: fractions of a rupee are rounded up to the next whole rupee. */
export function roundUpToRupee(amount) {
  return Math.ceil(roundToPaisa(amount));
}

/** Progressive tax on `taxableIncome` with per-slab detail. */
export function computeSlabTax(taxableIncome, slabs) {
  const slabLines = [];
  let lowerBound = 0;
  let slabTax = 0;
  for (const [upperLimit, rateBasisPoints] of slabs) {
    if (taxableIncome <= lowerBound) break;
    const slabTop = upperLimit === null ? taxableIncome : Math.min(taxableIncome, upperLimit);
    const incomeInSlab = slabTop - lowerBound;
    const taxInSlab = applyRate(incomeInSlab, rateBasisPoints);
    slabLines.push({ from: lowerBound, to: slabTop, ratePercent: rateBasisPoints / 100, incomeInSlab, tax: taxInSlab });
    slabTax = roundToPaisa(slabTax + taxInSlab);
    if (upperLimit === null) break;
    lowerBound = upperLimit;
  }
  return { slabTax, slabLines };
}
