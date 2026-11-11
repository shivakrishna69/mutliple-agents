/**
 * Component tests (npm test): React components rendered in jsdom with Testing Library, the backend
 * calls mocked per test; the files under src/ named *.test.js or *.test.jsx. Browser journeys against
 * a real backend are Playwright's (e2e/, npm run test:e2e).
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    setupFiles: ['./src/test/setup.js'],
  },
});
