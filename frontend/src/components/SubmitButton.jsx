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
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-indigo-400"
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
