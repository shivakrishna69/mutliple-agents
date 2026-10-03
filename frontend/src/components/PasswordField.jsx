/**
 * Password input with a show/hide toggle (eye icon). Accepts every FormField prop except
 * `inputType` and `trailingControl`, which it controls.
 *
 * Accessibility: the toggle is a real button with an aria-label that names the action
 * ("Show password" / "Hide password") and aria-pressed reflecting the state. It is type="button" so
 * it never submits the form, and it keeps focus on the input's side of the page.
 * Security: visibility is local UI state only and resets to hidden whenever the field remounts.
 */

import { useState } from 'react';
import FormField from './FormField.jsx';

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  );
}

function EyeSlashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  );
}

export default function PasswordField(formFieldProps) {
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const toggleLabel = isPasswordVisible ? 'Hide password' : 'Show password';

  return (
    <FormField
      {...formFieldProps}
      inputType={isPasswordVisible ? 'text' : 'password'}
      trailingControl={
        <button
          type="button"
          onClick={() => setIsPasswordVisible((previousVisibility) => !previousVisibility)}
          aria-label={toggleLabel}
          aria-pressed={isPasswordVisible}
          title={toggleLabel}
          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
        >
          {isPasswordVisible ? <EyeSlashIcon /> : <EyeIcon />}
        </button>
      }
    />
  );
}
