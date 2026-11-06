/**
 * The sign-up design's own fields, in the signed-out screens' look (FIELD_APPEARANCES.auth):
 *
 *   PhoneNumberField  a country button (flag, +calling code) beside the number; the button opens a
 *                     searchable list of the server's countries (GET /api/auth/options)
 *   BirthDateField    typed as mm/dd/yyyy (the design), slashes added while typing, or picked from
 *                     the browser's calendar (utils/birthDates.js turns it into what the server reads)
 *   SelectField       a native select with the design's chevron and a placeholder choice
 *   CodeEntry         the emailed code's boxes under a label row that offers to resend it
 *
 * None of them checks anything: the server validates and its messages appear under each field.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AUTH_LINK_CLASS, FIELD_APPEARANCES } from '../../constants/formStyles.js';
import { formatCountdown } from '../../hooks/useCountdown.js';
import VerificationCodeInput from './VerificationCodeInput.jsx';
import { CalendarIcon, ChevronDownIcon, SearchIcon } from '../Icons.jsx';
import { fromIsoDate, latestBirthDate, maskBirthDate } from '../../utils/birthDates.js';

const look = FIELD_APPEARANCES.auth;

// One small SVG per country (country-flag-icons, MIT), fetched only when shown.
const FLAG_URLS = Object.fromEntries(
  Object.entries(
    import.meta.glob('/node_modules/country-flag-icons/3x2/*.svg', { query: '?url', import: 'default', eager: true }),
  ).map(([path, url]) => [path.split('/').at(-1).replace('.svg', ''), url]),
);

function Flag({ code }) {
  const url = FLAG_URLS[code];
  if (!url) return <span className="inline-block h-[14px] w-[21px] rounded-[3px] bg-slate-200" aria-hidden="true" />;
  return (
    <img
      src={url}
      alt=""
      width="21"
      height="14"
      loading="lazy"
      className="h-[14px] w-[21px] shrink-0 rounded-[3px] object-cover ring-1 ring-slate-900/10"
    />
  );
}

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} className={look.error}>
      {message}
    </p>
  );
}

/** Where the country list opens: under the button, or above it when the window has no room below. */
function listPosition(anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.max(rect.width, 288);
  const roomBelow = window.innerHeight - rect.bottom;
  const placement = roomBelow < 300 ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 };
  return { position: 'fixed', left: Math.min(rect.left, window.innerWidth - width - 8), width, ...placement };
}

/**
 * @param {{ fieldId: string, label: string, countries: ReadonlyArray<{ code: string, name: string,
 *   callingCode: string }>, countryCode: string, onCountryChange: (code: string) => void,
 *   value: string, onChange: (value: string) => void, placeholder?: string,
 *   errorMessage?: string|null, countryErrorMessage?: string|null }} props
 */
export function PhoneNumberField({
  fieldId,
  label,
  countries,
  countryCode,
  onCountryChange,
  value,
  onChange,
  placeholder,
  errorMessage = null,
  countryErrorMessage = null,
}) {
  const listId = useId();
  const groupRef = useRef(null);
  const searchRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState(null);
  const country = countries.find((candidate) => candidate.code === countryCode);
  const shownError = countryErrorMessage ?? errorMessage;
  const errorId = `${fieldId}-error`;

  const matches = useMemo(() => {
    const wanted = search.trim().toLowerCase().replace(/^\+/, '');
    if (!wanted) return countries;
    return countries.filter(
      (candidate) =>
        candidate.name.toLowerCase().includes(wanted) ||
        candidate.callingCode.startsWith(wanted) ||
        candidate.code.toLowerCase() === wanted,
    );
  }, [countries, search]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const close = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'mousedown' && event.target.closest?.(`[data-country-list="${listId}"]`)) return;
      if (event.type === 'mousedown' && groupRef.current?.contains(event.target)) return;
      setIsOpen(false);
    };
    const reposition = () => groupRef.current && setPosition(listPosition(groupRef.current));
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('resize', reposition);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('resize', reposition);
    };
  }, [isOpen, listId]);

  function toggle() {
    if (!isOpen) {
      setSearch('');
      setPosition(listPosition(groupRef.current));
    }
    setIsOpen((open) => !open);
  }

  function choose(code) {
    onCountryChange(code);
    setIsOpen(false);
  }

  return (
    <div>
      <label htmlFor={fieldId} className={look.label}>
        {label}
      </label>
      <div
        ref={groupRef}
        className={`${look.gap} flex h-[clamp(2.75rem,5.6vh,3.25rem)] items-center rounded-xl border bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition focus-within:ring-4 ${
          shownError
            ? 'border-red-300 focus-within:border-red-500 focus-within:ring-red-100'
            : 'border-slate-200/90 hover:border-slate-300 focus-within:border-brand-500 focus-within:ring-brand-100'
        }`}
      >
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listId : undefined}
          aria-label={country ? `Country: ${country.name}, +${country.callingCode}` : 'Choose a country'}
          className="flex h-full shrink-0 items-center gap-1.5 rounded-l-xl pr-1.5 pl-3.5 text-[15px] text-slate-700 focus-visible:outline-none"
        >
          {country && <Flag code={country.code} />}
          <span className="tabular-nums">{country ? `+${country.callingCode}` : '+'}</span>
          <ChevronDownIcon
            className={`h-3.5 w-3.5 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
        <input
          id={fieldId}
          name={fieldId}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={value}
          placeholder={placeholder}
          onChange={(changeEvent) => onChange(changeEvent.target.value)}
          aria-invalid={shownError ? 'true' : 'false'}
          aria-describedby={shownError ? errorId : undefined}
          className="h-full min-w-0 flex-1 rounded-r-xl bg-transparent pr-4 pl-1.5 text-[15px] text-slate-900 placeholder:text-slate-400 focus:outline-none"
        />
      </div>
      <FieldError id={errorId} message={shownError} />

      {/*
        The list is drawn on the page itself (a portal into <body>), not inside the form: the form's
        entrance animation leaves a transform on it, and a transformed ancestor would make the
        list's fixed position relative to the form instead of the window. auth-theme keeps it blue.
      */}
      {isOpen &&
        position &&
        createPortal(
          <div
            data-country-list={listId}
            style={position}
            className="auth-theme z-50 overflow-hidden rounded-xl border border-slate-200 bg-white font-sans shadow-2xl shadow-blue-900/15"
          >
            <div className="flex items-center gap-2 border-b border-slate-100 px-3">
              <SearchIcon className="h-4 w-4 text-slate-400" />
              <input
                ref={searchRef}
                type="search"
                value={search}
                onChange={(changeEvent) => setSearch(changeEvent.target.value)}
                onKeyDown={(keyEvent) => {
                  if (keyEvent.key === 'Enter' && matches[0]) {
                    keyEvent.preventDefault();
                    choose(matches[0].code);
                  }
                }}
                placeholder="Search country or code"
                aria-label="Search countries"
                className="h-10 w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
              />
            </div>
            <ul id={listId} role="listbox" aria-label="Countries" className="max-h-60 overflow-y-auto py-1">
              {matches.map((candidate) => (
                <li key={candidate.code} role="option" aria-selected={candidate.code === countryCode}>
                  <button
                    type="button"
                    onClick={() => choose(candidate.code)}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-brand-50 focus-visible:bg-brand-50 focus-visible:outline-none ${
                      candidate.code === countryCode ? 'font-semibold text-brand-700' : 'text-slate-700'
                    }`}
                  >
                    <Flag code={candidate.code} />
                    <span className="flex-1 truncate">{candidate.name}</span>
                    <span className="text-slate-400 tabular-nums">+{candidate.callingCode}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * @param {{ fieldId: string, label: string, value: string, onChange: (value: string) => void,
 *   minimumAgeYears?: number|null, errorMessage?: string|null }} props
 */
export function BirthDateField({ fieldId, label, value, onChange, minimumAgeYears = null, errorMessage = null }) {
  const pickerRef = useRef(null);
  const errorId = `${fieldId}-error`;

  function openCalendar() {
    const picker = pickerRef.current;
    if (!picker) return;
    if (typeof picker.showPicker === 'function') picker.showPicker();
    else picker.focus();
  }

  return (
    <div>
      <label htmlFor={fieldId} className={look.label}>
        {label}
      </label>
      <div className={`relative ${look.gap}`}>
        <input
          id={fieldId}
          name={fieldId}
          type="text"
          inputMode="numeric"
          autoComplete="bday"
          placeholder="mm/dd/yyyy"
          value={value}
          onChange={(changeEvent) => onChange(maskBirthDate(changeEvent.target.value))}
          aria-invalid={errorMessage ? 'true' : 'false'}
          aria-describedby={errorMessage ? errorId : undefined}
          className={`${look.input} ${look.trailingPadding} ${errorMessage ? look.invalid : look.valid}`}
        />
        <button
          type="button"
          onClick={openCalendar}
          aria-label="Pick the date from a calendar"
          className="absolute inset-y-0 right-2 my-auto flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
        >
          <CalendarIcon className="h-5 w-5" />
        </button>
        <input
          ref={pickerRef}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          max={minimumAgeYears ? latestBirthDate(minimumAgeYears) : undefined}
          onChange={(changeEvent) => changeEvent.target.value && onChange(fromIsoDate(changeEvent.target.value))}
          className="pointer-events-none absolute right-2 bottom-0 h-0 w-0 opacity-0"
        />
      </div>
      <FieldError id={errorId} message={errorMessage} />
    </div>
  );
}

/**
 * @param {{ fieldId: string, label: string, value: string, onChange: (value: string) => void,
 *   choices: ReadonlyArray<{ value: string, label: string }>, placeholder: string,
 *   errorMessage?: string|null }} props
 */
export function SelectField({ fieldId, label, value, onChange, choices, placeholder, errorMessage = null }) {
  const errorId = `${fieldId}-error`;
  return (
    <div>
      <label htmlFor={fieldId} className={look.label}>
        {label}
      </label>
      <div className={`relative ${look.gap}`}>
        <select
          id={fieldId}
          name={fieldId}
          value={value}
          onChange={(changeEvent) => onChange(changeEvent.target.value)}
          aria-invalid={errorMessage ? 'true' : 'false'}
          aria-describedby={errorMessage ? errorId : undefined}
          className={`${look.input} ${look.trailingPadding} cursor-pointer appearance-none ${value ? '' : 'text-slate-400!'} ${
            errorMessage ? look.invalid : look.valid
          }`}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value} className="text-slate-900">
              {choice.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute inset-y-0 right-4 my-auto h-4 w-4 text-slate-400" />
      </div>
      <FieldError id={errorId} message={errorMessage} />
    </div>
  );
}

/**
 * The emailed code, as in the reset design: a label row with "Didn't receive code? Resend in
 * 00:45" (or a Resend button once the wait is over), the boxes, and the server's message.
 * @param {{ label: string, length: number, value: string, onChange: (code: string) => void,
 *   errorMessage?: string|null, hasError?: boolean, secondsLeft: number, onResend: () => void,
 *   isResending?: boolean, autoFocus?: boolean }} props
 */
export function CodeEntry({
  label,
  length,
  value,
  onChange,
  errorMessage = null,
  hasError = false,
  secondsLeft,
  onResend,
  isResending = false,
  autoFocus = false,
}) {
  const labelId = useId();
  const errorId = `${labelId}-error`;
  return (
    <div>
      <div className="mb-[clamp(0.4rem,1vh,0.6rem)] flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p id={labelId} className={look.label}>
          {label}
        </p>
        <p className="text-[13px] text-slate-500" aria-live="polite">
          Didn&apos;t receive code?{' '}
          {secondsLeft > 0 ? (
            <span className="font-semibold text-brand-600 tabular-nums">Resend in {formatCountdown(secondsLeft)}</span>
          ) : (
            <button type="button" onClick={onResend} disabled={isResending} className={AUTH_LINK_CLASS}>
              {isResending ? 'Sending…' : 'Resend code'}
            </button>
          )}
        </p>
      </div>
      <VerificationCodeInput
        length={length}
        value={value}
        onChange={onChange}
        labelId={labelId}
        hasError={hasError || Boolean(errorMessage)}
        describedBy={errorMessage ? errorId : undefined}
        autoFocus={autoFocus}
      />
      <FieldError id={errorId} message={errorMessage} />
    </div>
  );
}
