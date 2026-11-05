/**
 * The boxes signed-out screens show the server's words in:
 *   SuccessNotice   a successful answer's `message` ("Check your email…", "Your password has been
 *                   changed…"); role="status", announced politely
 *   CheckboxField   a labelled checkbox with the server's field error under it (terms, remember me)
 * Errors use components/ErrorBanner.jsx with the server's message.
 */

export function SuccessNotice({ children }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
    >
      <svg
        className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
          clipRule="evenodd"
        />
      </svg>
      <div className="flex-1">{children}</div>
    </div>
  );
}

/**
 * @param {{ fieldId: string, checked: boolean, onChange: (checked: boolean) => void,
 *   children: React.ReactNode, errorMessage?: string|null }} props
 */
export function CheckboxField({ fieldId, checked, onChange, children, errorMessage = null }) {
  const errorId = `${fieldId}-error`;
  return (
    <div>
      <div className="flex items-start gap-3">
        <input
          id={fieldId}
          name={fieldId}
          type="checkbox"
          checked={checked}
          onChange={(changeEvent) => onChange(changeEvent.target.checked)}
          aria-invalid={errorMessage ? 'true' : 'false'}
          aria-describedby={errorMessage ? errorId : undefined}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 accent-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
        />
        <label htmlFor={fieldId} className="text-sm leading-relaxed text-slate-600">
          {children}
        </label>
      </div>
      {errorMessage && (
        <p id={errorId} className="mt-1.5 text-sm text-red-600">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
