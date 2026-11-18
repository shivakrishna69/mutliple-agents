/**
 * The theme switch (ThemeToggle.jsx with hooks/useTheme.js): light by default, toggled and remembered
 * in this browser, still switching when storage is blocked, and labelled by what it does.
 */

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from '../constants/theme.js';
import { readStoredTheme, useTheme } from '../hooks/useTheme.js';
import ThemeToggle from './ThemeToggle.jsx';

function Harness() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div data-theme={theme} data-testid="shell">
      <ThemeToggle theme={theme} onToggle={toggleTheme} />
    </div>
  );
}

describe('theme', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('starts light, switches to dark and back, and remembers the choice', () => {
    render(<Harness />);
    const shell = screen.getByTestId('shell');
    const toggle = screen.getByRole('button', { name: 'Switch to the dark theme' });
    expect(shell.dataset.theme).toBe('light');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(shell.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    const back = screen.getByRole('button', { name: 'Switch to the light theme' });
    expect(back.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(back);
    expect(shell.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('reads a remembered theme, and ignores anything it does not know', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readStoredTheme()).toBe('dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readStoredTheme()).toBe('light');
  });

  it('still switches for the visit when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('dark');
  });
});
