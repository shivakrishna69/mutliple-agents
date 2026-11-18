/**
 * The theme switch in the top bar (hooks/useTheme.js): a sun in the light theme, a moon in the dark
 * one. Its label says what pressing it does; aria-pressed says whether the dark theme is on.
 */

import { THEMES, THEME_LABELS } from '../constants/theme.js';
import { MoonIcon, SunIcon } from './Icons.jsx';

export default function ThemeToggle({ theme, onToggle }) {
  const isDark = theme === THEMES.DARK;
  const labels = THEME_LABELS[theme];
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={labels.switchTo}
      aria-pressed={isDark}
      title={labels.name}
      data-testid="theme-toggle"
      className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-600 ring-1 ring-slate-200 transition hover:text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
    >
      {isDark ? <MoonIcon className="h-[1.1rem] w-[1.1rem]" /> : <SunIcon className="h-[1.1rem] w-[1.1rem]" />}
    </button>
  );
}
