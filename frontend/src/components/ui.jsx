/**
 * Shared presentation primitives for the workforce screens (payroll, attendance, analytics, OKRs,
 * vault, telemetry). Pure presentation: no data fetching. The visual language follows AppShell:
 * white cards on slate-50, indigo/violet accents, rounded-2xl surfaces, soft rings for depth.
 */

import { useId } from 'react';

const BUTTON_VARIANTS = Object.freeze({
  primary:
    'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-sm shadow-indigo-600/20 hover:from-indigo-500 hover:to-violet-500 focus-visible:ring-indigo-500',
  secondary: 'bg-white text-slate-700 ring-1 ring-slate-200 ring-inset hover:bg-slate-50 focus-visible:ring-indigo-500',
  ghost: 'text-slate-600 hover:bg-slate-100 focus-visible:ring-indigo-500',
  danger: 'bg-rose-600 text-white hover:bg-rose-500 focus-visible:ring-rose-500',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500 focus-visible:ring-emerald-500',
});

export function Button({ variant = 'primary', size = 'md', isBusy = false, className = '', children, disabled, type = 'button', ...buttonProps }) {
  const sizeClassName = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2.5 text-sm';
  return (
    <button
      type={type}
      disabled={disabled || isBusy}
      aria-busy={isBusy || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${sizeClassName} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...buttonProps}
    >
      {isBusy && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className = 'h-6 w-6' }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
    </svg>
  );
}

export function LoadingBlock({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-slate-500" role="status">
      <Spinner className="h-5 w-5 text-indigo-500" />
      {label}
    </div>
  );
}

export function Card({ title, subtitle, actions = null, className = '', bodyClassName = 'p-5 sm:p-6', children }) {
  return (
    <section className={`rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-6">
          <div>
            {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

const STAT_ACCENTS = Object.freeze({
  indigo: 'from-indigo-500 to-violet-500',
  emerald: 'from-emerald-500 to-teal-500',
  amber: 'from-amber-500 to-orange-500',
  rose: 'from-rose-500 to-pink-500',
  sky: 'from-sky-500 to-cyan-500',
  slate: 'from-slate-500 to-slate-600',
});

export function StatTile({ label, value, hint, accent = 'indigo', Icon = null }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
      <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${STAT_ACCENTS[accent]}`} aria-hidden="true" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
          <p className="mt-2 truncate text-2xl font-bold tracking-tight text-slate-900">{value}</p>
          {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
        </div>
        {Icon && (
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${STAT_ACCENTS[accent]}`}>
            <Icon className="h-5 w-5" />
          </span>
        )}
      </div>
    </div>
  );
}

const BADGE_TONES = Object.freeze({
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  rose: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  sky: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
});

export function Badge({ tone = 'slate', children, className = '' }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE_TONES[tone]} ${className}`}>{children}</span>;
}

/** Accessible tab bar. `tabs`: [{ id, label, Icon?, badge? }]. */
export function Tabs({ tabs, activeTabId, onChange, label }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto rounded-2xl bg-slate-100/80 p-1 ring-1 ring-slate-200/60 scroll-thin">
      {tabs.map(({ id, label: tabLabel, Icon, badge }) => {
        const isActive = id === activeTabId;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(id)}
            className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none ${
              isActive ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {Icon && <Icon className={`h-4 w-4 ${isActive ? 'text-indigo-600' : ''}`} />}
            {tabLabel}
            {badge !== undefined && badge !== null && <span className="rounded-full bg-indigo-600 px-1.5 text-[0.65rem] text-white">{badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({ title, description, Icon = null, action = null }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/50 px-6 py-14 text-center">
      {Icon && (
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-indigo-500 shadow-sm ring-1 ring-slate-200">
          <Icon className="h-6 w-6" />
        </span>
      )}
      <p className="mt-4 text-sm font-semibold text-slate-900">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

const PROGRESS_TONES = Object.freeze({
  indigo: 'from-indigo-500 to-violet-500',
  emerald: 'from-emerald-500 to-teal-400',
  amber: 'from-amber-500 to-orange-400',
  rose: 'from-rose-500 to-pink-500',
});

export function ProgressBar({ value, tone = 'indigo', label }) {
  const clampedValue = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clampedValue)} aria-label={label}>
      <div className={`h-full rounded-full bg-gradient-to-r ${PROGRESS_TONES[tone]} transition-[width] duration-500`} style={{ width: `${clampedValue}%` }} />
    </div>
  );
}

/** Tone for a 0-100 progress value: rose below 40, amber below 70, emerald otherwise. */
export function progressTone(progressValue) {
  if (progressValue >= 70) return 'emerald';
  if (progressValue >= 40) return 'amber';
  return 'rose';
}

const INPUT_CLASS_NAME =
  'block w-full rounded-xl border-0 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm ring-1 ring-slate-300 ring-inset placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500';

/** Label + control + hint/error. `children` receives the generated control id. */
export function Field({ label, hint, error, children, className = '' }) {
  const controlId = useId();
  return (
    <div className={className}>
      <label htmlFor={controlId} className="block text-xs font-semibold tracking-wide text-slate-600 uppercase">
        {label}
      </label>
      <div className="mt-1.5">{children(controlId, INPUT_CLASS_NAME + (error ? ' ring-rose-400' : ''))}</div>
      {error ? <p className="mt-1 text-xs text-rose-600">{error}</p> : hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function TextInput({ label, hint, error, className, ...inputProps }) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(controlId, inputClassName) => <input id={controlId} className={inputClassName} aria-invalid={Boolean(error) || undefined} {...inputProps} />}
    </Field>
  );
}

export function SelectInput({ label, hint, error, options, className, ...selectProps }) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(controlId, inputClassName) => (
        <select id={controlId} className={inputClassName} aria-invalid={Boolean(error) || undefined} {...selectProps}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Toggle({ label, description, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </span>
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(changeEvent) => onChange(changeEvent.target.checked)} />
      <span className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full bg-slate-300 transition peer-checked:bg-indigo-600 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-5" aria-hidden="true" />
    </label>
  );
}

/** Small inline notice. tone: info | success | warning | error. */
export function Notice({ tone = 'info', title, children, onDismiss }) {
  const toneClassName = {
    info: 'bg-indigo-50 text-indigo-900 ring-indigo-200',
    success: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
    warning: 'bg-amber-50 text-amber-900 ring-amber-200',
    error: 'bg-rose-50 text-rose-900 ring-rose-200',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-3 rounded-xl px-4 py-3 text-sm ring-1 ${toneClassName}`}>
      <div className="flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="-m-1 rounded-md p-1 opacity-60 hover:opacity-100" aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}

// --- Formatting --------------------------------------------------------------------------------

const INR_FORMATTER = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const INR_PRECISE_FORMATTER = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatInr(amount, { precise = false } = {}) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '—';
  return (precise ? INR_PRECISE_FORMATTER : INR_FORMATTER).format(Number(amount));
}

export function formatDate(isoValue, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!isoValue) return '—';
  const parsedDate = new Date(isoValue);
  return Number.isNaN(parsedDate.getTime()) ? String(isoValue) : parsedDate.toLocaleDateString('en-IN', options);
}

export function formatDateTime(isoValue) {
  if (!isoValue) return '—';
  return new Date(isoValue).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function formatBytes(byteCount) {
  if (!Number.isFinite(byteCount)) return '—';
  if (byteCount < 1024) return `${byteCount} B`;
  if (byteCount < 1024 * 1024) return `${(byteCount / 1024).toFixed(1)} KB`;
  return `${(byteCount / (1024 * 1024)).toFixed(1)} MB`;
}

export const MONTH_NAMES = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);

/** Opens a short-lived signed URL in a new tab without giving that tab access to this window. */
export function openSignedUrl(signedUrl) {
  window.open(signedUrl, '_blank', 'noopener,noreferrer');
}
