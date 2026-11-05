/**
 * One box per digit of the emailed code (the number of boxes is the server's
 * verificationCodeDigits). Typing moves to the next box, Backspace to the previous one, the arrow
 * keys move freely, and pasting the whole code fills every box at once. Only digits are kept.
 *
 * Accessibility: the boxes form a labelled group; each box says which digit it is. The parent gets
 * the code as one string.
 */

import { useRef } from 'react';

const onlyDigits = (text) => text.replace(/\D/g, '');

/**
 * @param {{ length: number, value: string, onChange: (code: string) => void, disabled?: boolean,
 *   hasError?: boolean, labelId: string, describedBy?: string, autoFocus?: boolean }} props
 */
export default function VerificationCodeInput({
  length,
  value,
  onChange,
  disabled = false,
  hasError = false,
  labelId,
  describedBy,
  autoFocus = false,
}) {
  const boxRefs = useRef([]);
  const digits = Array.from({ length }, (_, index) => value[index] ?? '');

  const focusBox = (index) => boxRefs.current[Math.max(0, Math.min(length - 1, index))]?.focus();

  function writeFrom(startIndex, typedDigits) {
    const nextDigits = [...digits];
    typedDigits.split('').forEach((digit, offset) => {
      if (startIndex + offset < length) nextDigits[startIndex + offset] = digit;
    });
    onChange(nextDigits.join('').slice(0, length));
    focusBox(startIndex + typedDigits.length);
  }

  function handleChange(index, changeEvent) {
    const typed = onlyDigits(changeEvent.target.value);
    if (!typed) return;
    // A box keeps one digit: typing into a filled box replaces it with the newest digit.
    writeFrom(index, typed.length > 1 && digits[index] ? typed.slice(-1) : typed);
  }

  function handleKeyDown(index, keyEvent) {
    if (keyEvent.key === 'Backspace') {
      keyEvent.preventDefault();
      const nextDigits = [...digits];
      const target = digits[index] ? index : index - 1;
      if (target >= 0) nextDigits[target] = '';
      onChange(nextDigits.join(''));
      focusBox(target);
    } else if (keyEvent.key === 'ArrowLeft') {
      keyEvent.preventDefault();
      focusBox(index - 1);
    } else if (keyEvent.key === 'ArrowRight') {
      keyEvent.preventDefault();
      focusBox(index + 1);
    }
  }

  function handlePaste(index, pasteEvent) {
    const pasted = onlyDigits(pasteEvent.clipboardData.getData('text'));
    if (!pasted) return;
    pasteEvent.preventDefault();
    writeFrom(pasted.length >= length ? 0 : index, pasted.slice(0, length));
  }

  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} className="flex gap-2 sm:gap-3">
      {digits.map((digit, index) => (
        <input
          // The boxes never reorder, so their position is a stable key.
          key={index}
          ref={(element) => {
            boxRefs.current[index] = element;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          pattern="[0-9]*"
          maxLength={length}
          value={digit}
          disabled={disabled}
          autoFocus={autoFocus && index === 0}
          aria-label={`Digit ${index + 1} of ${length}`}
          aria-invalid={hasError ? 'true' : 'false'}
          onChange={(changeEvent) => handleChange(index, changeEvent)}
          onKeyDown={(keyEvent) => handleKeyDown(index, keyEvent)}
          onPaste={(pasteEvent) => handlePaste(index, pasteEvent)}
          onFocus={(focusEvent) => focusEvent.target.select()}
          className={[
            'h-14 w-full min-w-0 rounded-xl border bg-white text-center text-xl font-semibold text-slate-900 shadow-sm transition sm:h-16 sm:text-2xl',
            'focus:outline-none focus:ring-4 disabled:cursor-not-allowed disabled:bg-slate-100',
            hasError
              ? 'border-red-300 focus:border-red-500 focus:ring-red-100'
              : 'border-slate-200 focus:border-brand-500 focus:ring-brand-100',
          ].join(' ')}
        />
      ))}
    </div>
  );
}
