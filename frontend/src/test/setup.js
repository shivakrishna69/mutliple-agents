/** Runs before every component test file (vitest.config.js): each test starts with an empty page. */

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
