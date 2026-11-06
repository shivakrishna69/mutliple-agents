/**
 * Full-width form submit button with a loading state.
 * While `isSubmitting` is true the button is disabled (blocking repeat clicks), shows a
 * spinner with `loadingLabel`, and sets `aria-busy` so assistive technology knows work is
 * in progress. `appearance` "auth" is the signed-out screens' solid blue button; `trailingIcon`
 * (decorative) follows the label, e.g. an arrow.
 */

const BUTTON_APPEARANCES = Object.freeze({
  default:
    'rounded-xl bg-gradient-to-r from-brand-600 to-brand-700 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/25 hover:from-brand-500 hover:to-brand-600 focus-visible:ring-4 focus-visible:ring-brand-200',
  auth: 'h-[clamp(2.75rem,5.8vh,3.35rem)] rounded-xl bg-brand-600 px-5 text-[15px] font-semibold text-white shadow-[0_10px_24px_-10px_rgba(31,91,255,0.75)] hover:bg-brand-500 hover:shadow-[0_14px_30px_-12px_rgba(31,91,255,0.85)] active:translate-y-px focus-visible:ring-4 focus-visible:ring-brand-200',
});

export default function SubmitButton({
  isSubmitting,
  idleLabel,
  loadingLabel,
  appearance = 'default',
  trailingIcon = null,
}) {
  return (
    <button
      type="submit"
      disabled={isSubmitting}
      aria-busy={isSubmitting}
      className={`group flex w-full items-center justify-center gap-2 transition focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-70 ${BUTTON_APPEARANCES[appearance]}`}
    >
      {isSubmitting && (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
        </svg>
      )}
      {isSubmitting ? loadingLabel : idleLabel}
      {!isSubmitting && trailingIcon && (
        <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">
          {trailingIcon}
        </span>
      )}
    </button>
  );
}
