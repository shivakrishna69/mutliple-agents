/**
 * How text fields look (components/FormField.jsx and the sign-up fields in
 * components/auth/AuthFields.jsx): "default" on the signed-in pages, "auth" on the signed-out
 * screens. Class names only; one place, so every field of a kind looks the same.
 */

export const FIELD_APPEARANCES = Object.freeze({
  default: Object.freeze({
    label: 'block text-sm font-medium text-slate-700',
    gap: 'mt-1.5',
    input:
      'block w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:outline-none focus:ring-4 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
    leadingPadding: 'pl-11',
    trailingPadding: 'pr-11',
    valid: 'border-slate-200 hover:border-slate-300 focus:border-brand-500 focus:ring-brand-100',
    invalid: 'border-red-300 focus:border-red-500 focus:ring-red-100',
    error: 'mt-1.5 text-sm text-red-600',
  }),
  auth: Object.freeze({
    label: 'block text-[13px] font-semibold tracking-[0.01em] text-slate-700',
    gap: 'mt-[clamp(0.3rem,0.8vh,0.5rem)]',
    input:
      'block h-[clamp(2.75rem,5.6vh,3.25rem)] w-full rounded-xl border bg-white px-4 text-[15px] text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition placeholder:text-slate-400 focus:outline-none focus:ring-4 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500',
    leadingPadding: 'pl-11',
    trailingPadding: 'pr-12',
    valid: 'border-slate-200/90 hover:border-slate-300 focus:border-brand-500 focus:ring-brand-100',
    invalid: 'border-red-300 focus:border-red-500 focus:ring-red-100',
    error: 'mt-1.5 text-[13px] text-red-600',
  }),
});

/** A text link on the signed-out screens ("Forgot password?", "Sign up", "Back to Sign In"). */
export const AUTH_LINK_CLASS =
  'rounded font-semibold text-brand-600 transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
