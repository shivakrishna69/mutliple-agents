/**
 * Task dates, the "follows" link and the review flow on a department board, against the real server:
 *   - start and due dates (the due date not before the start), kept null on tasks that have none;
 *   - the task a task follows: on the same board, never itself, never in a loop; the task's detail
 *     names what it follows and what follows it;
 *   - submitting (moving to In review) records the review and notifies the board's leads, not the
 *     person who submitted; the assignee is not blocked;
 *   - only leads review: asking for changes needs a note, sends the task back to In progress and
 *     tells the assignee; approving marks it Done quietly; a task not in review cannot be reviewed;
 *   - taking a task back out of review clears the waiting review; a lead moving it to Done approves it.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertDepartment, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const mongoReason = await mongoUnavailableReason();
const boardPath = (departmentId) => `/api/departments/${departmentId}`;

describe('task dates, follows links and reviews', { skip: mongoReason ?? false }, () => {
  let testServer;
  let engineering;
  let finance;
  let head;
  let lead;
  let designer;
  let developer;
  let financeTaskId;

  const asId = (id) => new testServer.database.base.Types.ObjectId(id);
  const tasksPath = (departmentId = engineering) => `${boardPath(departmentId)}/tasks`;
  const create = (client, body, departmentId = engineering) => client.post(tasksPath(departmentId), body);
  const detailOf = async (client, taskId) => (await client.get(`${tasksPath()}/${taskId}`)).body.data;
  const versionOf = async (taskId) => (await detailOf(head.client, taskId)).task.version;
  const change = async (client, taskId, changes) =>
    client.patch(`${tasksPath()}/${taskId}`, { ...changes, version: await versionOf(taskId) });
  const review = async (client, taskId, body) =>
    client.post(`${tasksPath()}/${taskId}/review`, { ...body, version: await versionOf(taskId) });
  const notificationsOf = (person, type) =>
    testServer.database
      .collection('notifications')
      .find({ userId: asId(person.userId), type })
      .toArray();

  before(async () => {
    testServer = await startTestServer({ mail: false, environment: { LOG_LEVEL: 'warn' } });
    const hr = await createSignedInClient(testServer, { name: 'Hari HR', email: 'hari.hr@example.com', role: 'hr' });
    engineering = await insertDepartment(testServer.database, { name: 'Engineering', code: 'ENG', budgetCode: 'CC-1' });
    finance = await insertDepartment(testServer.database, { name: 'Finance', code: 'FIN', budgetCode: 'CC-2' });
    const onboard = (email, name, departmentId) =>
      onboardEmployee({ testServer, hrClient: hr, email, name, departmentId });
    head = await onboard('hema.head@example.com', 'Hema Head', engineering);
    lead = await onboard('lalit.lead@example.com', 'Lalit Lead', engineering);
    designer = await onboard('dia.design@example.com', 'Dia Designer', engineering);
    developer = await onboard('dev.front@example.com', 'Dev Frontend', engineering);
    const financePerson = await onboard('fin.person@example.com', 'Fin Person', finance);
    await testServer.database
      .collection('departments')
      .updateOne({ _id: asId(engineering) }, { $set: { departmentHeadId: asId(head.profileId) } });
    const board = (await head.client.get(`${boardPath(engineering)}/board`)).body.data.board;
    const named = await head.client.request('PUT', `${boardPath(engineering)}/task-leads`, {
      body: { leadUserIds: [lead.userId], version: board.version },
    });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    financeTaskId = (await create(financePerson.client, { title: 'Close the books' }, finance)).body.data.task.id;
  });

  after(async () => {
    await testServer?.stop();
  });

  let designId;
  let frontendId;

  it('keeps start and due dates, never a due date before the start, and null where none is given', async () => {
    const plain = await create(designer.client, { title: 'Old style task' });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    assert.equal(plain.body.data.task.startDate, null);
    assert.equal(plain.body.data.task.dueDate, null);
    assert.equal(plain.body.data.task.review, null);

    const backwards = await create(designer.client, {
      title: 'Backwards',
      startDate: '2026-12-10',
      dueDate: '2026-12-01',
    });
    assert.equal(backwards.status, 400);
    assert.ok(backwards.body.error.details.some((detail) => detail.field === 'dueDate'));
    const notADate = await create(designer.client, { title: 'Bad date', dueDate: '2026-02-30' });
    assert.equal(notADate.status, 400);

    const design = await create(designer.client, {
      title: 'Design the HR portal',
      assigneeId: designer.userId,
      startDate: '2026-11-24',
      dueDate: '2026-11-27',
      priority: 'HIGH',
    });
    assert.equal(design.status, 201, JSON.stringify(design.body));
    designId = design.body.data.task.id;
    assert.deepEqual([design.body.data.task.startDate, design.body.data.task.dueDate], ['2026-11-24', '2026-11-27']);
  });

  it('links a task to the one it follows on the same board, refusing itself, other boards and loops', async () => {
    const frontend = await create(designer.client, {
      title: 'Frontend development',
      assigneeId: designer.userId,
      dependsOnTaskId: designId,
      startDate: '2026-11-28',
      dueDate: '2026-11-30',
    });
    assert.equal(frontend.status, 201, JSON.stringify(frontend.body));
    frontendId = frontend.body.data.task.id;
    assert.equal(frontend.body.data.task.dependsOnTaskId, designId);

    const designDetail = await detailOf(designer.client, designId);
    assert.deepEqual(
      designDetail.followedBy.map((next) => [next.title, next.dueDate]),
      [['Frontend development', '2026-11-30']],
    );
    const frontendDetail = await detailOf(designer.client, frontendId);
    assert.equal(frontendDetail.dependsOn.title, 'Design the HR portal');

    const otherBoard = await create(designer.client, { title: 'Cross', dependsOnTaskId: financeTaskId });
    assert.deepEqual([otherBoard.status, otherBoard.body.error.code], [422, 'TASK_DEPENDENCY_NOT_FOUND']);
    const self = await change(designer.client, designId, { dependsOnTaskId: designId });
    assert.deepEqual([self.status, self.body.error.code], [409, 'TASK_DEPENDENCY_LOOP']);
    const loop = await change(designer.client, designId, { dependsOnTaskId: frontendId });
    assert.deepEqual([loop.status, loop.body.error.code], [409, 'TASK_DEPENDENCY_LOOP']);

    // A member cannot re-plan someone else's task.
    const byOther = await change(developer.client, designId, { dueDate: '2026-12-01' });
    assert.deepEqual([byOther.status, byOther.body.error.code], [403, 'TASK_EDIT_NOT_ALLOWED']);
    // Its assignee can, and the activity records it.
    assert.equal((await change(designer.client, frontendId, { dueDate: '2026-12-02' })).status, 200);
    const history = (await detailOf(designer.client, frontendId)).activity;
    assert.ok(
      history.some((entry) =>
        entry.changes.some(
          (item) => item.field === 'dueDate' && item.from === '2026-11-30' && item.to === '2026-12-02',
        ),
      ),
    );
  });

  it('submits for review without blocking the assignee, and tells the leads', async () => {
    await change(designer.client, designId, { status: 'IN_PROGRESS' });
    const submitted = await change(designer.client, designId, { status: 'IN_REVIEW' });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const { review } = submitted.body.data.task;
    assert.equal(review.state, 'SUBMITTED');
    assert.equal(review.submittedBy.name, 'Dia Designer');
    assert.equal(review.decidedBy, null);

    // The next step is theirs to start straight away.
    const started = await change(designer.client, frontendId, { status: 'IN_PROGRESS' });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    for (const leadPerson of [head, lead]) {
      const [notification] = await notificationsOf(leadPerson, 'TASK_REVIEW_REQUESTED');
      assert.ok(notification, 'each lead is told');
      assert.match(notification.body, /Dia Designer submitted "Design the HR portal" for review/);
      assert.equal(notification.link, `/boards/${engineering}?task=${designId}`);
    }
    assert.equal((await notificationsOf(designer, 'TASK_REVIEW_REQUESTED')).length, 0);
  });

  it('lets only leads review, and needs a note to ask for changes', async () => {
    const byMember = await review(developer.client, designId, { decision: 'APPROVE' });
    assert.deepEqual([byMember.status, byMember.body.error.code], [403, 'LEADS_ONLY']);
    const noNote = await review(lead.client, designId, { decision: 'REQUEST_CHANGES' });
    assert.equal(noNote.status, 400);
    assert.ok(noNote.body.error.details.some((detail) => detail.field === 'note'));
    const unknown = await review(lead.client, designId, { decision: 'MAYBE' });
    assert.equal(unknown.status, 400);
    const notInReview = await review(lead.client, frontendId, { decision: 'APPROVE' });
    assert.deepEqual([notInReview.status, notInReview.body.error.code], [409, 'TASK_NOT_IN_REVIEW']);
  });

  it('sends work back for changes with the note, and tells only the assignee', async () => {
    const sentBack = await review(lead.client, designId, {
      decision: 'REQUEST_CHANGES',
      note: 'Use the brand colours on the header',
    });
    assert.equal(sentBack.status, 200, JSON.stringify(sentBack.body));
    assert.equal(sentBack.body.message, 'Changes requested; the task is back in progress');
    const { task } = sentBack.body.data;
    assert.equal(task.status, 'IN_PROGRESS');
    assert.equal(task.review.state, 'CHANGES_REQUESTED');
    assert.equal(task.review.note, 'Use the brand colours on the header');
    assert.equal(task.review.decidedBy.name, 'Lalit Lead');

    const [notification] = await notificationsOf(designer, 'TASK_CHANGES_REQUESTED');
    assert.match(notification.body, /Lalit Lead asked for changes to "Design the HR portal": Use the brand colours/);
    assert.equal((await notificationsOf(head, 'TASK_CHANGES_REQUESTED')).length, 0);
    const history = (await detailOf(designer.client, designId)).activity;
    assert.ok(history.some((entry) => entry.body === 'Use the brand colours on the header'));
  });

  it('approves a resubmission quietly and marks it done', async () => {
    const resubmitted = await change(designer.client, designId, { status: 'IN_REVIEW' });
    assert.equal(resubmitted.body.data.task.review.state, 'SUBMITTED');
    assert.equal(resubmitted.body.data.task.review.note, null);

    const approved = await review(head.client, designId, { decision: 'APPROVE' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.message, 'Task approved and marked done');
    const { task } = approved.body.data;
    assert.equal(task.status, 'DONE');
    assert.ok(task.doneAt);
    assert.equal(task.review.state, 'APPROVED');
    assert.equal(task.review.decidedBy.name, 'Hema Head');
    assert.equal((await notificationsOf(designer, 'TASK_CHANGES_REQUESTED')).length, 1, 'no new interruption');
  });

  it('clears a waiting review when work is taken back, and approves when a lead moves it to Done', async () => {
    await change(designer.client, frontendId, { status: 'IN_REVIEW' });
    const takenBack = await change(designer.client, frontendId, { status: 'IN_PROGRESS' });
    assert.equal(takenBack.body.data.task.review, null);

    await change(designer.client, frontendId, { status: 'IN_REVIEW' });
    const done = await change(lead.client, frontendId, { status: 'DONE' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.task.review.state, 'APPROVED');
    assert.equal(done.body.data.task.review.decidedBy.name, 'Lalit Lead');
  });
});
