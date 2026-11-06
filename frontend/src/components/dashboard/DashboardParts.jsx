/**
 * The dashboard's building blocks, in the dashboard design's look:
 *
 *   Panel      a white rounded section with a title, a line under it and an optional action
 *   StatCard   a figure with its label, icon, a note, and a footer line with an optional link
 *   Pill       a small rounded label (status pills, badges)
 *   Skeleton   a grey placeholder while figures load
 *   StatusChip a conversation's status, in its colour (constants/conversationDisplay.js)
 */

import { Link } from 'react-router';
import { CONVERSATION_STATUS_DISPLAY, UNKNOWN_STATUS_DISPLAY } from '../../constants/conversationDisplay.js';
import { STAT_TONES } from '../../constants/dashboardDisplay.js';
import { ArrowRightIcon } from '../Icons.jsx';

export function Panel({ title, subtitle, action = null, className = '', children }) {
  return (
    <section
      className={`rounded-[1.6rem] border border-slate-200/70 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-7 ${className}`}
    >
      {(title || action) && (
        <header className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title && <h2 className="text-lg font-semibold tracking-tight text-slate-900 sm:text-xl">{title}</h2>}
            {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** A text link with an arrow ("Open console →"). */
export function ArrowLink({ to, children }) {
  return (
    <Link
      to={to}
      className="inline-flex shrink-0 items-center gap-1.5 rounded text-sm font-semibold text-brand-600 transition hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
    >
      {children}
      <ArrowRightIcon className="h-4 w-4" />
    </Link>
  );
}

export function Pill({ className = 'bg-slate-100 text-slate-600', children }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

export function Skeleton({ className = 'h-8 w-16' }) {
  return <span className={`inline-block animate-pulse rounded-lg bg-slate-100 ${className}`} aria-hidden="true" />;
}

/**
 * @param {{ label: string, value: React.ReactNode, suffix?: React.ReactNode, Icon: Function,
 *   tone?: keyof STAT_TONES, note?: string, footer?: React.ReactNode, link?: { to: string, label: string },
 *   isLoading?: boolean }} props
 */
export function StatCard({ label, value, suffix = null, Icon, tone = 'blue', note, footer, link, isLoading = false }) {
  return (
    <article className="flex min-w-0 flex-col rounded-[1.4rem] border border-slate-200/70 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-snug text-slate-600">{label}</p>
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${STAT_TONES[tone]}`}>
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <div className="mt-3 flex min-h-[3.25rem] items-end gap-2">
        {isLoading ? (
          <Skeleton className="h-11 w-20" />
        ) : (
          <>
            <span className="text-[2.6rem] leading-none font-semibold tracking-tight text-slate-900">{value}</span>
            {suffix && <span className="mb-1.5 text-xs text-slate-500">{suffix}</span>}
          </>
        )}
      </div>
      {note && (
        <p className="mt-2 truncate text-xs text-slate-500" title={note}>
          {note}
        </p>
      )}
      {(footer || link) && (
        <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-xs text-slate-600">
          <span className="flex min-w-0 items-center gap-1.5 truncate">{footer}</span>
          {link && (
            <Link
              to={link.to}
              className="shrink-0 rounded font-semibold text-brand-600 hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
            >
              {link.label}
            </Link>
          )}
        </div>
      )}
    </article>
  );
}

export function StatusChip({ status }) {
  const display = CONVERSATION_STATUS_DISPLAY[status] ?? UNKNOWN_STATUS_DISPLAY;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${display.chipClassName}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${display.dotClassName}`} aria-hidden="true" />
      {display.label}
    </span>
  );
}
