/**
 * The browser keeps two small mirrors of constants/accessRoles.js: the capability names
 * (frontend/src/constants/capabilities.js) and how each role is shown (frontend/src/constants/routes.js
 * ROLE_DISPLAY). Both must match the server, or a page would hide something a person may use, or
 * name a role differently from the server's own messages and dropdowns.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CAPABILITIES, ROLES, ROLE_DEFINITIONS } from '../../constants/accessRoles.js';
import { CAPABILITIES as FRONTEND_CAPABILITIES } from '../../../frontend/src/constants/capabilities.js';
import { ROLE_DISPLAY, USER_ROLES } from '../../../frontend/src/constants/routes.js';

describe('the browser mirrors of the access roles', () => {
  it('names the same capabilities', () => {
    assert.deepEqual(FRONTEND_CAPABILITIES, CAPABILITIES);
  });

  it('knows every role, with the same label and description', () => {
    assert.deepEqual(USER_ROLES, ROLES);
    assert.deepEqual(Object.keys(ROLE_DISPLAY).sort(), Object.values(ROLES).sort());
    for (const { value, label, description } of ROLE_DEFINITIONS) {
      assert.equal(ROLE_DISPLAY[value].label, label, `${value} label`);
      assert.equal(ROLE_DISPLAY[value].description, description, `${value} description`);
    }
  });
});
