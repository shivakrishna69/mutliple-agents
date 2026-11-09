/**
 * The ai-service names each workflow it reports telemetry for (ai-service/app/telemetry.py
 * WORKFLOW_* constants); the backend accepts only the workflows in TELEMETRY_WORKFLOWS and drops the
 * events of any other. The two lists must match, or a workflow's events silently never reach the
 * telemetry console.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { TELEMETRY_WORKFLOWS } from '../../services/agentTelemetry.js';

const AI_SERVICE_TELEMETRY = new URL('../../../ai-service/app/telemetry.py', import.meta.url);
const WORKFLOW_CONSTANT_PATTERN = /^WORKFLOW_[A-Z_]+ = "([a-z_]+)"$/gm;

describe('telemetry workflows', () => {
  it('accepts exactly the workflows the ai-service reports', async () => {
    const source = await readFile(AI_SERVICE_TELEMETRY, 'utf8');
    const reported = [...source.matchAll(WORKFLOW_CONSTANT_PATTERN)].map((match) => match[1]);
    assert.ok(reported.length > 0, 'no WORKFLOW_* constants found in ai-service/app/telemetry.py');
    assert.deepEqual([...TELEMETRY_WORKFLOWS].sort(), reported.sort());
  });
});
