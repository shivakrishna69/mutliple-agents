/**
 * Labelled text input with an inline error message.
 *
 * Accessibility wiring:
 *   - <label htmlFor> is bound to the input id, so clicking the label focuses the input.
 *   - `aria-invalid` marks the field invalid for screen readers when an error is shown.
 *   - `aria-describedby` points at the error message and any hint (`describedByIds`), so
 *     screen readers read them after the label.
 *
 * `trailingControl` renders inside the input's right edge (e.g. the password visibility toggle);
 * the input gets matching right padding so text never runs under it.
 */

export default function FormField({
  fieldId,
  label,
  inputType = 'text',
  fieldValue,
  errorMessage,
  autoCompleteHint,
  inputRef,
  placeholder,
  describedByIds = [],
  trailingControl = null,
  onFieldChange,
  onFieldBlur,
  children,
}) {
  const errorMessageId = `${fieldId}-error`;
  const ariaDescribedBy = [errorMessage ? errorMessageId : null, ...describedByIds].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <label htmlFor={fieldId} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <div className="relative mt-1.5">
        <input
          id={fieldId}
          name={fieldId}
          type={inputType}
          ref={inputRef}
          value={fieldValue}
          placeholder={placeholder}
          onChange={onFieldChange}
          onBlur={onFieldBlur}
          autoComplete={autoCompleteHint}
          aria-invalid={errorMessage ? 'true' : 'false'}
          aria-describedby={ariaDescribedBy}
          className={[
            'block w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm transition',
            'placeholder:text-slate-400 focus:outline-none focus:ring-4',
            'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
            trailingControl ? 'pr-11' : '',
            errorMessage
              ? 'border-red-300 focus:border-red-500 focus:ring-red-100'
              : 'border-slate-200 hover:border-slate-300 focus:border-indigo-500 focus:ring-indigo-100',
          ].join(' ')}
        />
        {trailingControl && <div className="absolute inset-y-0 right-0 flex items-center pr-1.5">{trailingControl}</div>}
      </div>
      {errorMessage && (
        <p id={errorMessageId} className="mt-1.5 text-sm text-red-600">
          {errorMessage}
        </p>
      )}
      {children}
    </div>
  );
}
