/** The product logo (gradient chat bubble) with optional name. `tone` adapts the text to dark or light backgrounds. */

import { APP_NAME } from '../constants/app.js';

export default function BrandMark({ showName = true, tone = 'dark', size = 'md' }) {
  const markSize = size === 'lg' ? 'h-10 w-10' : 'h-8 w-8';
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className={`${markSize} inline-flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 shadow-lg shadow-indigo-500/30`}>
        <svg viewBox="0 0 24 24" className="h-1/2 w-1/2" fill="white" aria-hidden="true">
          <path d="M5 17.5V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9.5L5 20.5z" />
        </svg>
      </span>
      {showName && (
        <span className={`text-base font-bold tracking-tight ${tone === 'light' ? 'text-white' : 'text-slate-900'}`}>{APP_NAME}</span>
      )}
    </span>
  );
}
