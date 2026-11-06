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
 * the input gets matching right padding so text never runs under it. `leadingIcon` (decorative)
 * renders inside the left edge the same way. `appearance` picks the look: "default" for the
 * signed-in pages, "auth" for the signed-out screens' design (constants/formStyles.js).
 */

import { FIELD_APPEARANCES } from '../constants/formStyles.js';

export default function FormField({
  fieldId,
  label,
  inputType = 'text',
  fieldValue,
  errorMessage,
  autoCompleteHint,
  inputRef,
  placeholder,
  inputMode,
  maxLength,
  describedByIds = [],
  trailingControl = null,
  leadingIcon = null,
  appearance = 'default',
  onFieldChange,
  onFieldBlur,
  children,
}) {
  const look = FIELD_APPEARANCES[appearance];
  const errorMessageId = `${fieldId}-error`;
  const ariaDescribedBy =
    [errorMessage ? errorMessageId : null, ...describedByIds].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <label htmlFor={fieldId} className={look.label}>
        {label}
      </label>
      <div className={`relative ${look.gap}`}>
        {leadingIcon && (
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400">
            {leadingIcon}
          </div>
        )}
        <input
          id={fieldId}
          name={fieldId}
          type={inputType}
          ref={inputRef}
          value={fieldValue}
          placeholder={placeholder}
          inputMode={inputMode}
          maxLength={maxLength}
          onChange={onFieldChange}
          onBlur={onFieldBlur}
          autoComplete={autoCompleteHint}
          aria-invalid={errorMessage ? 'true' : 'false'}
          aria-describedby={ariaDescribedBy}
          className={[
            look.input,
            trailingControl ? look.trailingPadding : '',
            leadingIcon ? look.leadingPadding : '',
            errorMessage ? look.invalid : look.valid,
          ].join(' ')}
        />
        {trailingControl && <div className="absolute inset-y-0 right-0 flex items-center pr-2">{trailingControl}</div>}
      </div>
      {errorMessage && (
        <p id={errorMessageId} className={look.error}>
          {errorMessage}
        </p>
      )}
      {children}
    </div>
  );
}
