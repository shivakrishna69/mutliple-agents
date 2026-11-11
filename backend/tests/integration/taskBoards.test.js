/**
 * Department task boards on a real server: who is on a board and as what (members, the head, task
 * leads the head names, administrators; nobody from another department, HR included), sprints and
 * their one-active rule, tasks with their keys, who may change and move what, the activity log and
 * comments, filters, completing a sprint, team metrics, and assignment notifications.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TASK_MESSAGES } from '../../constants/messages.js';
import { insertDepartment, onboardEmployee } from './fixtures.js';
import { createSignedInClient, mongoUnavailableReason, startTestServer } from './testServer.js';

const mongoReason = await mongoUnavailableReason();
const boardPath = (departmentId) => `/api/departments/${departmentId}`;

describe('department task boards', { skip: mongoReason ?? false }, () => {
  let testServer;
  let admin;
  let hr;
  let engineering;
  let finance;
  let engHead;
  let engLead;
  let dev1;
  let dev2;
  let dev3;
  let finDev;
  let sprintId;

  const asId = (id) => new testServer.database.base.Types.ObjectId(id);
  const create = (client, body, departmentId = engineering) => client.post(`${boardPath(departmentId)}/tasks`, body);
  const taskOf = async (client, taskId) => (await client.get(`${boardPath(engineering)}/tasks/${taskId}`)).body.data;
  const change = async (client, taskId, changes) => {
    const { task } = await taskOf(engHead.client, taskId);
    return client.patch(`${boardPath(engineering)}/tasks/${taskId}`, { ...changes, version: task.version });
  };

  before(async () => {
    testServer = await startTestServer({ mail: false, environment: { LOG_LEVEL: 'warn' } });
    admin = await createSignedInClient(testServer, {
      name: 'Ada Admin',
      email: 'ada.admin@example.com',
      role: 'admin',
    });
    hr = await createSignedInClient(testServer, { name: 'Hari HR', email: 'hari.hr@example.com', role: 'hr' });
    engineering = await insertDepartment(testServer.database, {
      name: 'Engineering',
      code: 'ENG',
      budgetCode: 'CC-100',
    });
    finance = await insertDepartment(testServer.database, { name: 'Finance', code: 'FIN', budgetCode: 'CC-200' });
    const onboard = (email, name, departmentId) =>
      onboardEmployee({ testServer, hrClient: hr, email, name, departmentId });
    engHead = await onboard('esha.head@example.com', 'Esha Head', engineering);
    engLead = await onboard('lalit.lead@example.com', 'Lalit Lead', engineering);
    dev1 = await onboard('dev.one@example.com', 'Dev One', engineering);
    dev2 = await onboard('dev.two@example.com', 'Dev Two', engineering);
    dev3 = await onboard('dev.three@example.com', 'Dev Three', engineering);
    finDev = await onboard('fin.dev@example.com', 'Fin Dev', finance);
    await testServer.database
      .collection('departments')
      .updateOne({ _id: asId(engineering) }, { $set: { departmentHeadId: asId(engHead.profileId) } });
  });

  after(async () => {
    await testServer?.stop();
  });

  it("keeps a department's board to its own people and administrators", async () => {
    const codeOf = async (response) => [response.status, response.body.error?.code ?? null];
    assert.deepEqual(await codeOf(await finDev.client.get(`${boardPath(engineering)}/board`)), [403, 'NOT_A_MEMBER']);
    assert.deepEqual(await codeOf(await finDev.client.get(`${boardPath(engineering)}/tasks`)), [403, 'NOT_A_MEMBER']);
    assert.deepEqual(await codeOf(await finDev.client.get(`${boardPath(engineering)}/sprints`)), [403, 'NOT_A_MEMBER']);
    assert.deepEqual(await codeOf(await hr.get(`${boardPath(engineering)}/board`)), [403, 'NOT_A_MEMBER']);
    assert.deepEqual(await codeOf(await create(finDev.client, { title: 'Sneaky' })), [403, 'NOT_A_MEMBER']);
    assert.equal((await dev1.client.get(`${boardPath('not-an-id')}/board`)).status, 400);
    assert.equal((await dev1.client.get(`${boardPath('65f1a2b3c4d5e6f708192a3b')}/board`)).status, 404);
    assert.equal((await admin.get(`${boardPath(engineering)}/board`)).body.data.board.viewer.role, 'LEAD');
    // The department routes for HR are untouched: HR still reads the department itself.
    assert.equal((await hr.get(`/api/departments/${engineering}`)).status, 200);
  });

  it('lists the boards each person can open', async () => {
    const boardsOf = async (client) => {
      const response = await client.get('/api/task-boards');
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.data.boards.map((entry) => `${entry.department.code}:${entry.role}`);
    };
    assert.deepEqual(await boardsOf(dev1.client), ['ENG:MEMBER']);
    assert.deepEqual(await boardsOf(engHead.client), ['ENG:LEAD']);
    assert.deepEqual(await boardsOf(finDev.client), ['FIN:MEMBER']);
    assert.deepEqual(await boardsOf(hr), [], 'no employee record');
    assert.deepEqual(await boardsOf(admin), ['ENG:LEAD', 'FIN:LEAD']);
  });

  it('tells each person their role, and lets only the head name task leads from the department', async () => {
    const memberView = (await dev1.client.get(`${boardPath(engineering)}/board`)).body.data.board;
    assert.equal(memberView.viewer.role, 'MEMBER');
    assert.equal(memberView.viewer.canPlanSprints, false);
    assert.equal(memberView.head.name, 'Esha Head');
    assert.deepEqual(
      memberView.members.map((member) => member.name),
      ['Dev One', 'Dev Three', 'Dev Two', 'Esha Head', 'Lalit Lead'],
    );

    const headView = (await engHead.client.get(`${boardPath(engineering)}/board`)).body.data.board;
    assert.equal(headView.viewer.role, 'LEAD');
    assert.equal(headView.viewer.canChooseLeads, true);

    const byMember = await dev1.client.request('PUT', `${boardPath(engineering)}/task-leads`, {
      body: { leadUserIds: [dev1.userId], version: headView.version },
    });
    assert.equal(byMember.body.error.code, 'HEAD_ONLY');
    const outsider = await engHead.client.request('PUT', `${boardPath(engineering)}/task-leads`, {
      body: { leadUserIds: [finDev.userId], version: headView.version },
    });
    assert.equal(outsider.status, 422);
    assert.equal(outsider.body.error.code, 'LEAD_NOT_A_MEMBER');
    const named = await engHead.client.request('PUT', `${boardPath(engineering)}/task-leads`, {
      body: { leadUserIds: [engLead.userId], version: headView.version },
    });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    assert.deepEqual(
      named.body.data.board.leads.map((lead) => lead.name),
      ['Lalit Lead'],
    );
    assert.equal((await engLead.client.get(`${boardPath(engineering)}/board`)).body.data.board.viewer.role, 'LEAD');
  });

  it('lets leads plan sprints, one active at a time', async () => {
    const plan = { name: 'Sprint 1', goal: 'Ship login', startDate: '2026-11-09', endDate: '2026-11-20' };
    const byMember = await dev1.client.post(`${boardPath(engineering)}/sprints`, plan);
    assert.equal(byMember.status, 403);
    assert.equal(byMember.body.error.code, 'LEADS_ONLY');
    const backwards = await engLead.client.post(`${boardPath(engineering)}/sprints`, {
      ...plan,
      endDate: '2026-11-01',
    });
    assert.equal(backwards.status, 400);
    const missing = await engLead.client.post(`${boardPath(engineering)}/sprints`, { name: 'No dates' });
    assert.equal(missing.status, 400);

    const created = await engLead.client.post(`${boardPath(engineering)}/sprints`, plan);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.sprint.status, 'PLANNING');
    sprintId = created.body.data.sprint.id;
    const started = await engLead.client.patch(`${boardPath(engineering)}/sprints/${sprintId}`, {
      status: 'ACTIVE',
      version: created.body.data.sprint.version,
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.data.sprint.status, 'ACTIVE');
    assert.ok(started.body.data.sprint.startedAt);

    const second = (await engHead.client.post(`${boardPath(engineering)}/sprints`, { ...plan, name: 'Sprint 2' })).body
      .data.sprint;
    const alsoActive = await engHead.client.patch(`${boardPath(engineering)}/sprints/${second.id}`, {
      status: 'ACTIVE',
      version: second.version,
    });
    assert.equal(alsoActive.status, 409);
    assert.equal(alsoActive.body.error.code, 'SPRINT_ALREADY_ACTIVE');
    const skipping = await engHead.client.patch(`${boardPath(engineering)}/sprints/${second.id}`, {
      status: 'COMPLETED',
      version: second.version,
    });
    assert.equal(skipping.body.error.code, 'SPRINT_TRANSITION_NOT_ALLOWED');
    assert.equal(
      (await finDev.client.patch(`${boardPath(engineering)}/sprints/${second.id}`, { name: 'x', version: 0 })).status,
      403,
    );
  });

  let reported;
  let leadTask;

  it('numbers tasks per department, keeps members out of sprint planning, and assigns only within the department', async () => {
    const first = await create(dev1.client, {
      title: 'Fix login button',
      description: 'It does nothing on Safari.',
      taskType: 'BUG',
      priority: 'HIGH',
      assigneeId: dev2.userId,
      storyPoints: 3,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    reported = first.body.data.task;
    assert.equal(reported.key, 'ENG-1');
    assert.equal(reported.status, 'TODO');
    assert.equal(reported.sprintId, null, 'a member’s task starts in the backlog');
    assert.equal(reported.reporter.name, 'Dev One');
    assert.equal(reported.assignee.name, 'Dev Two');

    const notifications = await testServer.database
      .collection('notifications')
      .find({ userId: asId(dev2.userId) })
      .toArray();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'TASK_ASSIGNED');
    assert.equal(notifications[0].title, 'ENG-1 was assigned to you');
    assert.equal(notifications[0].link, `/boards/${engineering}?task=${reported.id}`);

    const intoSprint = await create(dev1.client, { title: 'Planned by a member', sprintId });
    assert.equal(intoSprint.body.error.code, 'TASK_SPRINT_NOT_ALLOWED');
    const outsideAssignee = await create(dev1.client, { title: 'For finance', assigneeId: finDev.userId });
    assert.equal(outsideAssignee.status, 422);
    assert.equal(outsideAssignee.body.error.code, 'ASSIGNEE_NOT_A_MEMBER');
    assert.equal((await create(dev1.client, { title: '' })).status, 400);
    assert.equal((await create(dev1.client, { title: 'Bad points', storyPoints: 2.5 })).status, 400);
    assert.equal((await create(dev1.client, { title: 'Bad type', taskType: 'EPIC' })).status, 400);

    const planned = await create(engLead.client, {
      title: 'Write release notes',
      sprintId,
      assigneeId: dev3.userId,
      storyPoints: 2,
    });
    assert.equal(planned.status, 201, JSON.stringify(planned.body));
    leadTask = planned.body.data.task;
    assert.equal(leadTask.key, 'ENG-2');
    assert.equal(leadTask.sprintId, sprintId);

    const financeTask = await create(finDev.client, { title: 'Close the books' }, finance);
    assert.equal(financeTask.body.data.task.key, 'FIN-1', 'each department numbers its own tasks');
  });

  it('lets the assignee move a task, the reporter edit it, and nobody else on the team either', async () => {
    const byReporter = await change(dev1.client, reported.id, { status: 'IN_PROGRESS' });
    assert.equal(byReporter.status, 403);
    assert.equal(byReporter.body.error.code, 'TASK_STATUS_NOT_ALLOWED');
    const byAssignee = await change(dev2.client, reported.id, { status: 'IN_PROGRESS' });
    assert.equal(byAssignee.status, 200, JSON.stringify(byAssignee.body));
    assert.equal(byAssignee.body.data.task.status, 'IN_PROGRESS');

    const renamed = await change(dev1.client, reported.id, { title: 'Fix the login button on Safari' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const stranger = await change(dev3.client, reported.id, { title: 'Hijacked' });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.error.code, 'TASK_EDIT_NOT_ALLOWED');
    const plannedByReporter = await change(dev1.client, reported.id, { sprintId });
    assert.equal(plannedByReporter.body.error.code, 'TASK_SPRINT_NOT_ALLOWED', 'only its assignee may pull it in');
    const outsider = await change(finDev.client, reported.id, { title: 'From finance' });
    assert.equal(outsider.status, 403);

    const skipsReview = await change(engLead.client, reported.id, { status: 'DONE' });
    assert.equal(skipsReview.status, 409);
    assert.equal(skipsReview.body.error.code, 'TASK_DONE_NEEDS_REVIEW', 'leads too go through In review');
    const plannedByLead = await change(engLead.client, reported.id, { sprintId, status: 'IN_REVIEW' });
    assert.equal(plannedByLead.status, 200, JSON.stringify(plannedByLead.body));
    assert.equal(plannedByLead.body.data.task.sprintId, sprintId);
    const doneByLead = await change(engLead.client, reported.id, { status: 'DONE' });
    assert.equal(doneByLead.status, 200, JSON.stringify(doneByLead.body));
    assert.ok(doneByLead.body.data.task.doneAt, 'reaching DONE is recorded');
    const reopened = await change(engLead.client, reported.id, { status: 'IN_REVIEW' });
    assert.equal(reopened.body.data.task.doneAt, null);

    const stale = await engLead.client.patch(`${boardPath(engineering)}/tasks/${reported.id}`, {
      status: 'DONE',
      version: 0,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_VERSION');

    const { activity } = await taskOf(dev1.client, reported.id);
    assert.deepEqual(
      activity.map((entry) => entry.type),
      ['CREATED', 'UPDATED', 'UPDATED', 'UPDATED', 'UPDATED', 'UPDATED'],
    );
    assert.deepEqual(activity[1].changes, [{ field: 'status', from: 'TODO', to: 'IN_PROGRESS' }]);
    assert.equal(activity[1].actor.name, 'Dev Two');
    assert.deepEqual(
      activity[2].changes,
      [{ field: 'title', from: null, to: null }],
      'text is not copied into the log',
    );
    assert.deepEqual(activity[3].changes.map((entry) => entry.field).sort(), ['sprintId', 'status']);
  });

  it('reassigns within the department, notifying the new assignee, and reorders a column', async () => {
    const reassigned = await change(dev2.client, reported.id, { assigneeId: dev3.userId });
    assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
    assert.equal(reassigned.body.data.task.assignee.name, 'Dev Three');
    const toDev3 = await testServer.database
      .collection('notifications')
      .find({ userId: asId(dev3.userId) })
      .toArray();
    assert.ok(toDev3.some((notification) => notification.data.taskId === reported.id));
    assert.equal((await change(engLead.client, reported.id, { assigneeId: finDev.userId })).status, 422);

    const moved = await change(engLead.client, leadTask.id, { orderIndex: 10 });
    assert.equal(moved.body.data.task.orderIndex, 10);
    assert.equal((await change(engLead.client, leadTask.id, { orderIndex: 'first' })).status, 400);
    assert.equal((await change(engLead.client, leadTask.id, { unknown: true })).status, 400);
  });

  it('filters tasks by sprint, assignee and status, within the department only', async () => {
    await create(dev1.client, { title: 'Unassigned idea' });
    const listOf = async (client, query = '') => {
      const response = await client.get(`${boardPath(engineering)}/tasks${query}`);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.data.tasks.map((task) => task.key);
    };
    assert.deepEqual((await listOf(dev1.client)).sort(), ['ENG-1', 'ENG-2', 'ENG-3']);
    assert.deepEqual(await listOf(dev1.client, `?sprintId=${sprintId}`), ['ENG-2', 'ENG-1']);
    assert.deepEqual(await listOf(dev1.client, '?sprintId=backlog'), ['ENG-3']);
    assert.deepEqual(await listOf(dev1.client, '?assignee=unassigned'), ['ENG-3']);
    assert.deepEqual((await listOf(dev3.client, '?assignee=me')).sort(), ['ENG-1', 'ENG-2']);
    assert.deepEqual(await listOf(dev1.client, `?assignee=${dev3.userId}&status=IN_REVIEW`), ['ENG-1']);
    assert.equal((await dev1.client.get(`${boardPath(engineering)}/tasks?status=LATER`)).status, 400);
    assert.equal((await dev1.client.get(`${boardPath(engineering)}/tasks?assignee=someone`)).status, 400);
    assert.equal((await dev1.client.get(`${boardPath(engineering)}/tasks?sprintId=current`)).status, 400);
    const financeTasks = (await finDev.client.get(`${boardPath(finance)}/tasks`)).body.data.tasks;
    assert.deepEqual(
      financeTasks.map((task) => task.key),
      ['FIN-1'],
    );
    assert.equal(
      (await finDev.client.get(`${boardPath(finance)}/tasks/${reported.id}`)).status,
      404,
      "another department's task",
    );
  });

  it('takes comments from the team only', async () => {
    const comment = await dev3.client.post(`${boardPath(engineering)}/tasks/${reported.id}/comments`, {
      body: '  Reproduced on iOS too.  ',
    });
    assert.equal(comment.status, 201, JSON.stringify(comment.body));
    assert.equal(comment.body.data.comment.body, 'Reproduced on iOS too.');
    assert.equal(comment.body.message, TASK_MESSAGES.COMMENT_ADDED);
    const { activity } = await taskOf(dev1.client, reported.id);
    assert.equal(activity.at(-1).type, 'COMMENTED');
    assert.equal(activity.at(-1).actor.name, 'Dev Three');
    assert.equal(
      (await dev3.client.post(`${boardPath(engineering)}/tasks/${reported.id}/comments`, { body: ' ' })).status,
      400,
    );
    assert.equal(
      (await finDev.client.post(`${boardPath(engineering)}/tasks/${reported.id}/comments`, { body: 'Hi' })).status,
      403,
    );
  });

  it("shows leads the team's work, and nobody else", async () => {
    assert.equal((await dev1.client.get(`${boardPath(engineering)}/tasks/metrics`)).body.error.code, 'LEADS_ONLY');
    const metrics = await engLead.client.get(`${boardPath(engineering)}/tasks/metrics?sprintId=${sprintId}`);
    assert.equal(metrics.status, 200, JSON.stringify(metrics.body));
    const dev3Work = metrics.body.data.members.find((entry) => entry.person.name === 'Dev Three');
    assert.deepEqual(dev3Work.tasksByStatus, { TODO: 1, IN_PROGRESS: 0, IN_REVIEW: 1, DONE: 0 });
    assert.equal(dev3Work.points, 5);
    assert.equal(metrics.body.data.totals.points, 5);
    const all = (await engHead.client.get(`${boardPath(engineering)}/tasks/metrics`)).body.data;
    assert.equal(all.unassigned.tasksByStatus.TODO, 1);
    assert.equal(all.sprint, null, 'no sprint chosen: no burndown');

    const { sprint } = metrics.body.data;
    assert.equal(sprint.id, sprintId);
    assert.equal(sprint.burndown.totalPoints, 5);
    assert.ok(
      sprint.burndown.days.every((day) => day.remainingPoints === 5),
      'nothing done yet',
    );
    assert.equal(sprint.burndown.days[0]?.date ?? '2026-11-09', '2026-11-09');
    const lastDay = sprint.burndown.today < '2026-11-20' ? sprint.burndown.today : '2026-11-20';
    assert.equal(sprint.burndown.days.at(-1)?.date ?? lastDay, lastDay, 'no days after today');
  });

  it('lists the unassigned backlog for leads, the most urgent first', async () => {
    await create(engLead.client, { title: 'Urgent and unowned', priority: 'URGENT' });
    await create(engLead.client, { title: 'Owned backlog work', assigneeId: dev1.userId });
    const { unassignedBacklog } = (await engLead.client.get(`${boardPath(engineering)}/tasks/metrics`)).body.data;
    assert.equal(unassignedBacklog.total, 2);
    assert.deepEqual(
      unassignedBacklog.tasks.map((task) => task.title),
      ['Urgent and unowned', 'Unassigned idea'],
    );
    assert.equal(unassignedBacklog.tasks[0].description, undefined, 'listed without descriptions');
    const financeBacklog = (await admin.get(`${boardPath(finance)}/tasks/metrics`)).body.data.unassignedBacklog;
    assert.equal(
      financeBacklog.tasks.some((task) => task.title === 'Urgent and unowned'),
      false,
      'per department',
    );
  });

  it('sends unfinished tasks back to the backlog when a sprint completes, and closes the sprint to new work', async () => {
    await change(dev3.client, leadTask.id, { status: 'IN_REVIEW' });
    const ownWork = await change(dev3.client, leadTask.id, { status: 'DONE' });
    assert.equal(ownWork.body.error.code, 'TASK_DONE_NOT_ALLOWED', 'the assignee does not approve their own work');
    assert.equal((await change(engLead.client, leadTask.id, { status: 'DONE' })).status, 200);
    const sprints = (await engLead.client.get(`${boardPath(engineering)}/sprints`)).body.data.sprints;
    const active = sprints.find((sprint) => sprint.id === sprintId);
    assert.deepEqual(active.progress.tasksByStatus, { TODO: 0, IN_PROGRESS: 0, IN_REVIEW: 1, DONE: 1 });
    assert.equal(active.progress.pointsDone, 2);
    const { burndown } = (await engLead.client.get(`${boardPath(engineering)}/tasks/metrics?sprintId=${sprintId}`)).body
      .data.sprint;
    if (burndown.days.length > 0) assert.equal(burndown.days.at(-1).remainingPoints, 3, 'done points burn down');

    const completed = await engLead.client.patch(`${boardPath(engineering)}/sprints/${sprintId}`, {
      status: 'COMPLETED',
      version: active.version,
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.data.sprint.status, 'COMPLETED');
    assert.equal((await taskOf(dev1.client, reported.id)).task.sprintId, null, 'unfinished: back to the backlog');
    assert.equal((await taskOf(dev1.client, leadTask.id)).task.sprintId, sprintId, 'done: stays in the sprint');

    const intoCompleted = await create(engLead.client, { title: 'Too late', sprintId });
    assert.equal(intoCompleted.status, 409);
    assert.equal(intoCompleted.body.error.code, 'SPRINT_COMPLETED');
    const reopen = await engLead.client.patch(`${boardPath(engineering)}/sprints/${sprintId}`, {
      name: 'Renamed',
      version: completed.body.data.sprint.version,
    });
    assert.equal(reopen.body.error.code, 'SPRINT_COMPLETED');
  });

  it('lets an assignee bring their backlog task into the active sprint, and the reporter mark it done from review', async () => {
    const created = await create(dev2.client, { title: 'Update the runbook', assigneeId: dev1.userId });
    const task = created.body.data.task;
    const sprints = (await engLead.client.get(`${boardPath(engineering)}/sprints`)).body.data.sprints;
    const planning = sprints.find((sprint) => sprint.name === 'Sprint 2');
    const intoPlanned = await change(dev1.client, task.id, { sprintId: planning.id });
    assert.equal(intoPlanned.body.error.code, 'TASK_SPRINT_NOT_ALLOWED', 'only into the active sprint');
    const started = await engLead.client.patch(`${boardPath(engineering)}/sprints/${planning.id}`, {
      status: 'ACTIVE',
      version: planning.version,
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const byOther = await change(dev3.client, task.id, { sprintId: planning.id, status: 'TODO' });
    assert.equal(byOther.body.error.code, 'TASK_SPRINT_NOT_ALLOWED', 'not someone else’s task');
    const pulled = await change(dev1.client, task.id, { sprintId: planning.id, status: 'TODO' });
    assert.equal(pulled.status, 200, JSON.stringify(pulled.body));
    assert.equal(pulled.body.data.task.sprintId, planning.id);
    const backOut = await change(dev1.client, task.id, { sprintId: null });
    assert.equal(backOut.body.error.code, 'TASK_SPRINT_NOT_ALLOWED', 'members do not take work out of a sprint');

    assert.equal((await change(dev1.client, task.id, { status: 'IN_PROGRESS' })).status, 200);
    assert.equal((await change(dev1.client, task.id, { status: 'DONE' })).body.error.code, 'TASK_DONE_NEEDS_REVIEW');
    assert.equal((await change(dev1.client, task.id, { status: 'IN_REVIEW' })).status, 200);
    assert.equal((await change(dev1.client, task.id, { status: 'DONE' })).body.error.code, 'TASK_DONE_NOT_ALLOWED');
    const byReporter = await change(dev2.client, task.id, { status: 'DONE' });
    assert.equal(byReporter.status, 200, JSON.stringify(byReporter.body));
    assert.equal(byReporter.body.data.task.status, 'DONE');
    const reopenedByReporter = await change(dev2.client, task.id, { status: 'IN_PROGRESS' });
    assert.equal(reopenedByReporter.body.error.code, 'TASK_STATUS_NOT_ALLOWED', 'reopening stays with its assignee');
  });
});
