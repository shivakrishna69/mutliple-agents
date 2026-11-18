/**
 * The signed-in app's two looks (styles/glass-theme.css): "Frosted Aurora Light", the default, and
 * "Obsidian Midnight Glass". The choice is kept in this browser under THEME_STORAGE_KEY.
 */

export const THEMES = Object.freeze({ LIGHT: 'light', DARK: 'dark' });
export const DEFAULT_THEME = THEMES.LIGHT;
export const THEME_STORAGE_KEY = 'nsk.theme';

/** The switch's labels: what pressing it does, and its name for assistive technology. */
export const THEME_LABELS = Object.freeze({
  [THEMES.LIGHT]: { name: 'Frosted Aurora Light', switchTo: 'Switch to the dark theme' },
  [THEMES.DARK]: { name: 'Obsidian Midnight Glass', switchTo: 'Switch to the light theme' },
});
