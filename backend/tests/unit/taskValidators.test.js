/**
 * Request shapes for department task boards (validators/taskValidators.js): ids, numbers and text
 * where they belong, unknown fields refused, filters, the version an edit is based on. Field values
 * themselves (enums, lengths, dates) are the models' job and are tested end to end.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TASK_SETTINGS } from '../../constants/validation.js';
import {
  validateComment,
  validateSprintChanges,
  validateSprintCreation,
  validateTaskChanges,
  validateTaskCreation,
  validateTaskLeads,
  validateTaskQuery,
} from '../../validators/taskValidators.js';

const ID = '65f1a2b3c4d5e6f708192a3b';

describe('task board requests', () => {
  it('validates a new task', () => {
    assert.deepEqual(
      validateTaskCreation({ title: 'Fix it', assigneeId: ID.toUpperCase(), storyPoints: 3 }).sanitizedInput,
      {
        title: 'Fix it',
        assigneeId: ID,
        storyPoints: 3,
      },
    );
    assert.ok(validateTaskCreation({ title: 'Unassigned', assigneeId: null, sprintId: null }).isValid);
    for (const body of [
      null,
      [],
      {},
      { title: '   ' },
      { title: 42 },
      { title: 'Hi', assigneeId: 'me' },
      { title: 'Hi', storyPoints: 1.5 },
      { title: 'Hi', storyPoints: '3' },
      { title: 'Hi', status: 'DONE' },
      { title: 'Hi', reporterId: ID },
      { title: 'Hi', $where: '1' },
    ]) {
      assert.equal(validateTaskCreation(body).isValid, false, JSON.stringify(body));
    }
  });

  it('validates changes to a task, with the version they are based on', () => {
    assert.deepEqual(validateTaskChanges({ status: 'DONE', orderIndex: 512.5, version: 2 }).sanitizedInput, {
      changes: { status: 'DONE', orderIndex: 512.5 },
      version: 2,
    });
    for (const body of [
      { status: 'DONE' },
      { version: 1 },
      { status: 'FINISHED', version: 1 },
      { orderIndex: Number.POSITIVE_INFINITY, version: 1 },
      { orderIndex: '1', version: 1 },
      { key: 'ENG-9', version: 1 },
    ]) {
      assert.equal(validateTaskChanges(body).isValid, false, JSON.stringify(body));
    }
  });

  it('validates filters', () => {
    assert.deepEqual(validateTaskQuery({}).sanitizedInput, { sprintId: null, assignee: null, status: null });
    assert.deepEqual(validateTaskQuery({ sprintId: 'backlog', assignee: 'me', status: 'TODO' }).sanitizedInput, {
      sprintId: 'backlog',
      assignee: 'me',
      status: 'TODO',
    });
    assert.ok(validateTaskQuery({ sprintId: ID, assignee: ID }).isValid);
    for (const query of [{ sprintId: 'current' }, { assignee: 'everyone' }, { status: 'todo' }]) {
      assert.equal(validateTaskQuery(query).isValid, false, JSON.stringify(query));
    }
  });

  it('validates comments, sprints and task leads', () => {
    assert.deepEqual(validateComment({ body: '  Done.  ' }).sanitizedInput, { body: 'Done.' });
    assert.equal(validateComment({ body: '' }).isValid, false);
    assert.equal(validateComment({ body: 'x'.repeat(TASK_SETTINGS.COMMENT_MAX_LENGTH + 1) }).isValid, false);
    assert.ok(validateSprintCreation({ name: 'Sprint 1', startDate: '2026-11-09', endDate: '2026-11-20' }).isValid);
    assert.equal(validateSprintCreation({ name: 'Sprint 1', startDate: '2026-11-09' }).isValid, false);
    assert.equal(validateSprintChanges({ status: 'DONE', version: 0 }).isValid, false);
    assert.ok(validateSprintChanges({ status: 'ACTIVE', version: 0 }).isValid);
    assert.deepEqual(validateTaskLeads({ leadUserIds: [ID.toUpperCase()], version: 0 }).sanitizedInput, {
      leadUserIds: [ID],
      version: 0,
    });
    assert.equal(validateTaskLeads({ leadUserIds: 'all', version: 0 }).isValid, false);
    assert.equal(
      validateTaskLeads({ leadUserIds: Array.from({ length: TASK_SETTINGS.LEADS_MAX + 1 }, () => ID), version: 0 })
        .isValid,
      false,
    );
  });
});
