/**
 * Labelled text input with an inline error message.
 *
 * Accessibility wiring:
 *   - <label htmlFor> is bound to the input id, so clicking the label focuses the input.
 *   - `aria-invalid` marks the field invalid for screen readers when an error is shown.
 *   - `aria-describedby` points at the error message and any hint (`describedByIds`), so
 *     screen readers read them after the label.
 */

export default function FormField({
  fieldId,
  label,
  inputType = 'text',
  fieldValue,
  errorMessage,
  autoCompleteHint,
  inputRef,
  describedByIds = [],
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
      <input
        id={fieldId}
        name={fieldId}
        type={inputType}
        ref={inputRef}
        value={fieldValue}
        onChange={onFieldChange}
        onBlur={onFieldBlur}
        autoComplete={autoCompleteHint}
        aria-invalid={errorMessage ? 'true' : 'false'}
        aria-describedby={ariaDescribedBy}
        className={[
          'mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors',
          'placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-offset-0',
          'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
          errorMessage
            ? 'border-red-400 focus:border-red-500 focus:ring-red-200'
            : 'border-slate-300 focus:border-indigo-500 focus:ring-indigo-200',
        ].join(' ')}
      />
      {errorMessage && (
        <p id={errorMessageId} className="mt-1.5 text-sm text-red-600">
          {errorMessage}
        </p>
      )}
      {children}
    </div>
  );
}
