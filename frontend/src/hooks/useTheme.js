/**
 * The signed-in app's theme (constants/theme.js):
 *
 *   const { theme, toggleTheme } = useTheme();
 *
 * Remembered in this browser; when storage is blocked (a private window, blocked site data) it starts
 * at DEFAULT_THEME each time and the switch still works for the visit.
 */

import { useCallback, useState } from 'react';
import { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY } from '../constants/theme.js';

const KNOWN_THEMES = Object.values(THEMES);

export function readStoredTheme() {
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return KNOWN_THEMES.includes(storedTheme) ? storedTheme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function useTheme() {
  const [theme, setTheme] = useState(readStoredTheme);

  const toggleTheme = useCallback(() => {
    setTheme((currentTheme) => {
      const nextTheme = currentTheme === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK;
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      } catch {
        // Not remembered in this browser; the theme still changes for now.
      }
      return nextTheme;
    });
  }, []);

  return { theme, toggleTheme };
}
