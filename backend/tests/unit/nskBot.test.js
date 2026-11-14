/**
 * The NSK assistant's pure pieces: the actor token (genuine, unexpired, unforgeable), the ai-service
 * response contract, which intents and tools each role gets, the resume offer, and request validation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { CAPABILITIES, ROLES, hasCapability } from '../../constants/accessRoles.js';
import { NSK_BOT_MESSAGES } from '../../constants/messages.js';
import { NSK_INTENTS, allowedIntentsFor, nskHasCapability } from '../../constants/nskBot.js';
import { NSK_BOT_SETTINGS } from '../../constants/validation.js';
import { AI_FAILURE_KIND, AiServiceError } from '../../services/aiServiceClient.js';
import { issueActorToken, verifyActorToken } from '../../services/nskBot/actorToken.js';
import { PEOPLE_SCOPES, peopleScopeOf, scopeCoversDepartment } from '../../services/nskBot/nskAccess.js';
import { resumeOffer } from '../../services/nskBot/nskBotService.js';
import { NSK_TOOLS, toolsAvailableTo } from '../../services/nskBot/nskTools.js';
import { parseNskTurnResponse } from '../../services/nskBot/nskTurnClient.js';
import { matchDepartment } from '../../services/nskBot/peopleTools.js';
import { maskPhone, revealProfile } from '../../services/nskBot/profileMasking.js';
import { validateNskMessage, validateNskToolCall } from '../../validators/nskBotValidators.js';

const KEY = randomBytes(32);
const USER_ID = '64b0000000000000000000a1';
const SESSION_ID = '64b0000000000000000000b1';
const NOW = new Date('2026-11-14T10:00:00Z');
const PEOPLE_TOOLS = [NSK_TOOLS.LOOKUP_EMPLOYEE_PROFILE, NSK_TOOLS.GET_DEPARTMENT_METRICS];

describe('the actor token', () => {
  const token = issueActorToken({ key: KEY, userId: USER_ID, sessionId: SESSION_ID, ttlSeconds: 120, now: NOW });

  it('names the person and the session while it lasts', () => {
    assert.deepEqual(verifyActorToken({ key: KEY, token, now: NOW }), { userId: USER_ID, sessionId: SESSION_ID });
    assert.deepEqual(verifyActorToken({ key: KEY, token, now: new Date(NOW.getTime() + 119_000) }), {
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  it('is refused once expired, under another key, altered or malformed', () => {
    assert.equal(verifyActorToken({ key: KEY, token, now: new Date(NOW.getTime() + 120_000) }), null);
    assert.equal(verifyActorToken({ key: randomBytes(32), token, now: NOW }), null);
    const [version, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const otherPerson = Buffer.from(JSON.stringify({ ...claims, u: '64b0000000000000000000a2' })).toString('base64url');
    assert.equal(verifyActorToken({ key: KEY, token: `${version}.${otherPerson}.${signature}`, now: NOW }), null);
    const longer = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 3600 })).toString('base64url');
    assert.equal(verifyActorToken({ key: KEY, token: `${version}.${longer}.${signature}`, now: NOW }), null);
    for (const malformed of [undefined, 42, '', 'v1', `v2.${payload}.${signature}`, `${token}.extra`]) {
      assert.equal(verifyActorToken({ key: KEY, token: malformed, now: NOW }), null, String(malformed));
    }
  });

  it('refuses a correctly signed payload that does not name ids', () => {
    const signedOdd = issueActorToken({ key: KEY, userId: 'admin', sessionId: SESSION_ID, ttlSeconds: 120, now: NOW });
    assert.equal(verifyActorToken({ key: KEY, token: signedOdd, now: NOW }), null);
  });
});

describe('what each role may use', () => {
  const SELF_INTENTS = [NSK_INTENTS.ATTENDANCE_AUDIT, NSK_INTENTS.POLICY_QA, NSK_INTENTS.GENERAL_HELP];
  const SELF_TOOLS = Object.values(NSK_TOOLS).filter((tool) => !PEOPLE_TOOLS.includes(tool));
  const PEOPLE_ROLES = [ROLES.ADMIN, ROLES.HR, ROLES.FINANCE, ROLES.IT_ADMIN];

  it('gives the people tools to admin, HR, finance and IT, self-service to the others', () => {
    for (const role of Object.values(ROLES)) {
      const looksUp = PEOPLE_ROLES.includes(role);
      assert.deepEqual(
        allowedIntentsFor(role),
        looksUp ? [NSK_INTENTS.PROFILE_LOOKUP, ...SELF_INTENTS] : SELF_INTENTS,
        role,
      );
      assert.deepEqual(toolsAvailableTo(role), looksUp ? Object.values(NSK_TOOLS) : SELF_TOOLS, role);
    }
  });

  it('gives a department head the people tools whatever their role, and nothing that is not built yet', () => {
    assert.deepEqual(allowedIntentsFor(ROLES.EMPLOYEE, { headsDepartment: true }), [
      NSK_INTENTS.PROFILE_LOOKUP,
      ...SELF_INTENTS,
    ]);
    assert.deepEqual(toolsAvailableTo(ROLES.AGENT, { headsDepartment: true }), Object.values(NSK_TOOLS));
    assert.equal(nskHasCapability(ROLES.EMPLOYEE, CAPABILITIES.MANAGE_COMPENSATION, { headsDepartment: true }), false);
    assert.equal(nskHasCapability('superuser', CAPABILITIES.RUN_PEOPLE_LOOKUP, { headsDepartment: true }), false);
    for (const role of Object.values(ROLES)) {
      const intents = allowedIntentsFor(role, { headsDepartment: true });
      assert.equal(intents.includes(NSK_INTENTS.OFFBOARDING_WORKFLOW), false);
      assert.equal(intents.includes(NSK_INTENTS.WEB_MARKET_RESEARCH), false);
    }
  });

  it('gives an unknown role nothing', () => {
    assert.deepEqual(allowedIntentsFor('superuser'), []);
    assert.deepEqual(toolsAvailableTo('superuser'), []);
  });
});

describe('people scope', () => {
  it('is the organisation with the capability, the headed departments for a head, otherwise none', () => {
    assert.deepEqual(peopleScopeOf({ role: ROLES.IT_ADMIN, headedDepartmentIds: ['d1'] }), {
      kind: PEOPLE_SCOPES.ORGANISATION,
    });
    const headScope = peopleScopeOf({ role: ROLES.EMPLOYEE, headedDepartmentIds: ['d1', 'd2'] });
    assert.deepEqual(headScope, { kind: PEOPLE_SCOPES.DEPARTMENTS, departmentIds: ['d1', 'd2'] });
    assert.equal(peopleScopeOf({ role: ROLES.EMPLOYEE, headedDepartmentIds: [] }), null);
    assert.equal(scopeCoversDepartment(headScope, 'd2'), true);
    assert.equal(scopeCoversDepartment(headScope, 'd3'), false);
    assert.equal(scopeCoversDepartment({ kind: PEOPLE_SCOPES.ORGANISATION }, 'd3'), true);
    assert.equal(scopeCoversDepartment(null, 'd1'), false);
  });

  it('finds a department by code, exact name, or one partial name', () => {
    const departments = [
      { name: 'Data Engineering', code: 'DE' },
      { name: 'Engineering', code: 'ENG' },
      { name: 'Finance', code: 'FIN' },
    ];
    assert.equal(matchDepartment(departments, 'fin').code, 'FIN');
    assert.equal(matchDepartment(departments, 'engineering').code, 'ENG');
    assert.equal(matchDepartment(departments, 'nance').code, 'FIN');
    assert.equal(matchDepartment(departments, 'eng').code, 'ENG');
    assert.equal(matchDepartment(departments, 'gineer'), null, 'two partial matches: ask');
    assert.equal(matchDepartment(departments, null), null);
    assert.equal(matchDepartment([departments[1]], null).code, 'ENG', 'the only one');
  });
});

describe('profile masking', () => {
  const full = {
    name: 'Rahul Sharma',
    employee_code: 'NSK0104',
    phone: '+919876543210',
    salary: { gross_monthly: 75000 },
    personal_email: 'rahul@personal.example',
  };

  it('masks the phone for every role and keeps only its last digits', () => {
    assert.equal(maskPhone('+919876543210'), '+••••••••••10');
    assert.equal(maskPhone('98765 43210'), '••••••••10');
    assert.equal(maskPhone(null), null);
    assert.equal(maskPhone('  '), null);
    for (const role of Object.values(ROLES)) assert.equal(revealProfile(full, role).profile.phone, '+••••••••••10');
  });

  it('shows salary only to roles that manage compensation, and drops fields it does not know', () => {
    for (const role of Object.values(ROLES)) {
      const { profile, fieldsShown } = revealProfile(full, role);
      const seesSalary = hasCapability(role, CAPABILITIES.MANAGE_COMPENSATION);
      assert.deepEqual(
        profile.salary,
        seesSalary ? { gross_monthly: 75000 } : { hidden: true, note: NSK_BOT_MESSAGES.SALARY_HIDDEN },
        role,
      );
      assert.equal(fieldsShown.includes('salary'), seesSalary, role);
      assert.equal(profile.personal_email, undefined);
      assert.deepEqual(
        fieldsShown.filter((field) => field !== 'salary'),
        ['name', 'employee_code', 'phone'],
      );
    }
  });
});

describe('the ai-service turn response', () => {
  const valid = {
    outcome: 'answered',
    reply: ' You have 6 casual leave days left [1]. ',
    classification: {
      intent: 'ATTENDANCE_AUDIT',
      sentiment: 'NEUTRAL',
      confidence: 0.92,
      topic: 'leave balance',
      entities: [{ kind: 'date', value: 'this year' }],
    },
    sources: [
      { number: 1, kind: 'tool', tool: 'my_leave_balances', label: 'Your leave balances' },
      {
        number: 2,
        kind: 'document',
        document_id: '64b0000000000000000000f1',
        department_id: '64b0000000000000000000e1',
        chunk_index: 0,
        heading_path: ['Leave'],
        page: null,
        excerpt: 'Casual leave is 12 days a year.',
        score: 0.8,
      },
      { number: 3, kind: 'conversation', session_id: SESSION_ID },
    ],
    suggestions: [{ text: 'Show my leave requests', intent: 'ATTENDANCE_AUDIT' }],
    tools_used: ['my_leave_balances'],
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  it('is read into the backend’s shape and values', () => {
    const parsed = parseNskTurnResponse(valid);
    assert.equal(parsed.outcome, 'ANSWERED');
    assert.equal(parsed.reply, 'You have 6 casual leave days left [1].');
    assert.deepEqual(
      parsed.sources.map((source) => source.kind),
      ['TOOL', 'DOCUMENT', 'CONVERSATION'],
    );
    assert.equal(parsed.sources[1].documentId, '64b0000000000000000000f1');
    assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 5 });
  });

  it('is refused when it breaks the contract', () => {
    const broken = [
      { ...valid, outcome: 'maybe' },
      { ...valid, reply: '  ' },
      { ...valid, reply: 'x'.repeat(NSK_BOT_SETTINGS.REPLY_MAX_LENGTH + 1) },
      { ...valid, classification: { ...valid.classification, intent: 'HACK' } },
      { ...valid, classification: { ...valid.classification, confidence: 2 } },
      { ...valid, classification: { ...valid.classification, entities: [{ kind: 'salary', value: '1' }] } },
      { ...valid, sources: [{ number: 1, kind: 'web', url: 'http://x' }] },
      { ...valid, sources: [{ ...valid.sources[1], document_id: 'not-an-id' }] },
      { ...valid, sources: [valid.sources[0], valid.sources[0]] },
      { ...valid, suggestions: Array(NSK_BOT_SETTINGS.SUGGESTIONS_MAX + 1).fill(valid.suggestions[0]) },
      { ...valid, tools_used: 'everything' },
      { ...valid, usage: { input_tokens: 'many' } },
      null,
    ];
    for (const body of broken) {
      assert.throws(
        () => parseNskTurnResponse(body),
        (error) => error instanceof AiServiceError && error.failureKind === AI_FAILURE_KIND.INVALID_RESPONSE,
      );
    }
  });
});

describe('the resume offer', () => {
  const latest = {
    _id: SESSION_ID,
    title: 'How many leaves do I have?',
    topics: ['leave balance'],
    lastIntent: 'ATTENDANCE_AUDIT',
    lastSuggestions: [
      { text: 'Show my leave requests', intent: 'ATTENDANCE_AUDIT' },
      { text: 'What is the leave policy?', intent: 'POLICY_QA' },
    ],
    messageCount: 2,
    lastMessageAt: new Date(NOW.getTime() - 26 * 60 * 60 * 1000),
    createdAt: NOW,
  };

  it('offers a recent session with a continue chip and its last suggestions', () => {
    const offer = resumeOffer(latest, NOW);
    assert.equal(offer.session.id, SESSION_ID);
    assert.equal(offer.prompt, NSK_BOT_MESSAGES.RESUME_PROMPT(latest.title));
    assert.deepEqual(offer.suggestions, [
      { text: NSK_BOT_MESSAGES.RESUME_CONTINUE(latest.title), intent: 'ATTENDANCE_AUDIT' },
      ...latest.lastSuggestions,
    ]);
  });

  it('offers nothing for an old session or none', () => {
    const old = {
      ...latest,
      lastMessageAt: new Date(NOW.getTime() - (NSK_BOT_SETTINGS.RESUME_WINDOW_HOURS + 1) * 3_600_000),
    };
    assert.equal(resumeOffer(old, NOW), null);
    assert.equal(resumeOffer(null, NOW), null);
  });
});

describe('request validation', () => {
  it('trims a message and refuses unknown fields and bad ids', () => {
    assert.deepEqual(validateNskMessage({ message: '  hi  ' }), {
      isValid: true,
      sanitizedInput: { message: 'hi', sessionId: null },
    });
    assert.equal(validateNskMessage({ message: 'hi', sessionId: 'nope' }).isValid, false);
    assert.equal(validateNskMessage({ message: 'hi', userId: USER_ID }).isValid, false);
    assert.equal(validateNskMessage({ message: 'x'.repeat(NSK_BOT_SETTINGS.MESSAGE_MAX_LENGTH + 1) }).isValid, false);
    assert.equal(validateNskMessage(['hi']).isValid, false);
  });

  it('checks a tool call’s shape', () => {
    assert.equal(validateNskToolCall({ tool: 'my_leave_balances' }, { actor_token: 't' }).isValid, true);
    assert.equal(validateNskToolCall({ tool: 'My-Tool' }, { actor_token: 't' }).isValid, false);
    assert.equal(validateNskToolCall({ tool: 'my_leave_balances' }, {}).isValid, false);
    assert.equal(
      validateNskToolCall({ tool: 'my_leave_balances' }, { actor_token: 't', arguments: [] }).isValid,
      false,
    );
    assert.equal(validateNskToolCall({ tool: 'my_leave_balances' }, { actor_token: 't', as: USER_ID }).isValid, false);
  });
});
