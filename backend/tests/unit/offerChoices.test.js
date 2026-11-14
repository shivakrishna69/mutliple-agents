/** The offer form's choices (GET /api/hr/onboarding/settings `choices`) name every value the engine takes. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GENDER_LABELS, PROFESSIONAL_TAX_STATE_LABELS, TAX_REGIME_LABELS } from '../../constants/messages.js';
import { GENDERS } from '../../constants/validation.js';
import { PROFESSIONAL_TAX_STATES, TAX_REGIMES } from '../../utils/payroll/rules.js';

describe('offer form choices', () => {
  it('labels every professional tax state, tax regime and gender', () => {
    assert.deepEqual(Object.keys(PROFESSIONAL_TAX_STATE_LABELS).sort(), Object.values(PROFESSIONAL_TAX_STATES).sort());
    assert.deepEqual(Object.keys(TAX_REGIME_LABELS).sort(), Object.values(TAX_REGIMES).sort());
    assert.deepEqual(Object.keys(GENDER_LABELS).sort(), Object.values(GENDERS).sort());
  });
});
