/**
 * Full-width form submit button with a loading state.
 * While `isSubmitting` is true the button is disabled (blocking repeat clicks), shows a
 * spinner with `loadingLabel`, and sets `aria-busy` so assistive technology knows work is
 * in progress.
 */

export default function SubmitButton({ isSubmitting, idleLabel, loadingLabel }) {
  return (
    <button
      type="submit"
      disabled={isSubmitting}
      aria-busy={isSubmitting}
      className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:from-indigo-500 hover:to-violet-500 focus-visible:ring-4 focus-visible:ring-indigo-200 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-70"
    >
      {isSubmitting && (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
        </svg>
      )}
      {isSubmitting ? loadingLabel : idleLabel}
    </button>
  );
}
