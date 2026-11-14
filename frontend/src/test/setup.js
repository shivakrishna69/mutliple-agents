/** Runs before every component test file (vitest.config.js): each test starts with an empty page. */

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

// jsdom has no ResizeObserver; charts (Recharts) observe their container's size with it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
