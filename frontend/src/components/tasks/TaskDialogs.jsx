/**
 * The task board's dialogs:
 *
 *   CreateTaskDialog   title, description, type, priority, assignee (people in the department),
 *                      story points, start and due dates, the task it follows; leads also choose the
 *                      sprint (members' tasks go to the backlog)
 *   TaskDetailDialog   a task with its fields, status, sprint, dates and the task it follows (each
 *                      editable when the viewer may, the same rules as the backend), what it follows
 *                      and what follows it, its activity log and its comments. On a task in review a
 *                      lead approves it or asks for changes with a note; a task sent back shows the
 *                      lead's note as a Revision requested banner
 *   SprintDialog       a new sprint: name, goal, start and end dates (leads)
 *
 * "Follows" lists only this board's tasks, never the task itself or one that already follows it (that
 * would be a loop; utils/taskBoard.js followableTasks); the backend checks again. Every error is the
 * backend's, shown in the dialog; an edit based on an old version reloads the task.
 */

import { useState } from 'react';
import {
  requestSprintCreation,
  requestTask,
  requestTaskComment,
  requestTaskCreation,
  requestTaskReview,
  requestTaskUpdate,
} from '../../api/tasksApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  ACTIVITY_FIELD_LABELS,
  BACKLOG,
  BOARD_COLUMNS,
  DEFAULT_PRIORITY,
  DEFAULT_TASK_TYPE,
  PRIORITY_OPTIONS,
  REVIEW_ACTIVITY_PHRASES,
  SPRINT_STATUSES,
  STATUS_LABELS,
  TASK_LIMITS,
  TASK_REVIEW_DECISIONS,
  TASK_STATUSES,
  TASK_TYPE_OPTIONS,
} from '../../constants/tasks.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import Dialog from '../Dialog.jsx';
import { Button, Field, LoadingBlock, Notice, SelectInput, TextInput, formatDate, formatDateTime } from '../ui.jsx';
import { allowedStatusesOf, canReviewTask, followableTasks, revisionOf, taskRightsOf } from '../../utils/taskBoard.js';

const UNASSIGNED = '';
const NOT_FOLLOWING = '';
const STALE_VERSION = 'STALE_VERSION';

const assigneeOptions = (members) => [
  { value: UNASSIGNED, label: 'Unassigned' },
  ...members.map((member) => ({ value: member.id, label: member.name })),
];
/** The tasks this one may follow (taskId null: a new task). */
const followOptions = (tasks, taskId) => [
  { value: NOT_FOLLOWING, label: 'None' },
  ...followableTasks(tasks, taskId).map((task) => ({ value: task.id, label: `${task.key} · ${task.title}` })),
];
const DATE_HINT = 'Optional';
const FOLLOWS_HINT = 'Optional: a task on this board to do first';

/** Start date, due date (not before the start) and the task it follows, as form fields. */
function ScheduleFields({ form, onField, fieldErrors, options, disabled = false }) {
  return (
    <>
      <TextInput
        label="Start date"
        type="date"
        value={form.startDate}
        onChange={onField('startDate')}
        max={form.dueDate || undefined}
        error={fieldErrors.startDate}
        hint={disabled ? undefined : DATE_HINT}
        disabled={disabled}
      />
      <TextInput
        label="Due date"
        type="date"
        value={form.dueDate}
        onChange={onField('dueDate')}
        min={form.startDate || undefined}
        error={fieldErrors.dueDate}
        hint={disabled ? undefined : DATE_HINT}
        disabled={disabled}
      />
      <SelectInput
        label="Follows task"
        value={form.dependsOnTaskId}
        onChange={onField('dependsOnTaskId')}
        error={fieldErrors.dependsOnTaskId}
        options={options}
        hint={disabled ? undefined : FOLLOWS_HINT}
        disabled={disabled}
      />
    </>
  );
}
const sprintOptions = (sprints) => [
  { value: BACKLOG, label: 'Backlog' },
  ...sprints.map((sprint) => ({ value: sprint.id, label: `${sprint.name} (${sprint.status.toLowerCase()})` })),
];
const pointsOf = (text) => (text === '' ? null : Number(text));

function TextArea({ label, value, onChange, error, maxLength, rows = 4, hint, autoFocus = false, disabled = false }) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(controlId, inputClassName) => (
        <textarea
          id={controlId}
          value={value}
          onChange={(changeEvent) => onChange(changeEvent.target.value)}
          maxLength={maxLength}
          rows={rows}
          data-autofocus={autoFocus || undefined}
          disabled={disabled}
          className={inputClassName}
        />
      )}
    </Field>
  );
}

/**
 * @param {{ departmentId: string, board: object, plannableSprints: object[], tasks: object[],
 *   defaultSprintId: string|null, onCreated: (task, notice) => void, onClose: () => void }} props
 */
export function CreateTaskDialog({
  departmentId,
  board,
  plannableSprints,
  tasks,
  defaultSprintId,
  onCreated,
  onClose,
}) {
  const { csrfToken } = useAuth();
  const canPlan = board.viewer.canPlanSprints;
  const [form, setForm] = useState({
    title: '',
    description: '',
    taskType: DEFAULT_TASK_TYPE,
    priority: DEFAULT_PRIORITY,
    assigneeId: UNASSIGNED,
    storyPoints: '',
    sprintId: canPlan && defaultSprintId ? defaultSprintId : BACKLOG,
    startDate: '',
    dueDate: '',
    dependsOnTaskId: NOT_FOLLOWING,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const update = (field) => (changeEvent) => setForm({ ...form, [field]: changeEvent.target.value });
  const fieldErrors = saveError?.fieldErrors ?? {};

  async function submit(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await requestTaskCreation(
        departmentId,
        {
          title: form.title.trim(),
          description: form.description,
          taskType: form.taskType,
          priority: form.priority,
          assigneeId: form.assigneeId || null,
          storyPoints: pointsOf(form.storyPoints),
          ...(canPlan && form.sprintId !== BACKLOG ? { sprintId: form.sprintId } : {}),
          ...(form.startDate ? { startDate: form.startDate } : {}),
          ...(form.dueDate ? { dueDate: form.dueDate } : {}),
          ...(form.dependsOnTaskId ? { dependsOnTaskId: form.dependsOnTaskId } : {}),
        },
        csrfToken,
      );
      onCreated(result.task, result.notice);
    } catch (createError) {
      setSaveError(toDisplayError(createError));
      setIsSaving(false);
    }
  }

  return (
    <Dialog title="Create a task" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {saveError && <Notice tone="error" title={saveError.message} />}
        <TextInput
          label="Title"
          value={form.title}
          onChange={update('title')}
          error={fieldErrors.title}
          maxLength={TASK_LIMITS.TITLE}
          required
          data-autofocus
        />
        <TextArea
          label="Description"
          value={form.description}
          onChange={(description) => setForm({ ...form, description })}
          error={fieldErrors.description}
          maxLength={TASK_LIMITS.DESCRIPTION}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectInput label="Type" value={form.taskType} onChange={update('taskType')} options={TASK_TYPE_OPTIONS} />
          <SelectInput
            label="Priority"
            value={form.priority}
            onChange={update('priority')}
            options={PRIORITY_OPTIONS}
          />
          <SelectInput
            label="Assignee"
            value={form.assigneeId}
            onChange={update('assigneeId')}
            error={fieldErrors.assigneeId}
            options={assigneeOptions(board.members)}
          />
          <TextInput
            label="Story points"
            type="number"
            min={0}
            max={TASK_LIMITS.STORY_POINTS}
            step={1}
            value={form.storyPoints}
            onChange={update('storyPoints')}
            error={fieldErrors.storyPoints}
            hint="Optional"
          />
          {canPlan && (
            <SelectInput
              label="Sprint"
              value={form.sprintId}
              onChange={update('sprintId')}
              error={fieldErrors.sprintId}
              options={sprintOptions(plannableSprints)}
            />
          )}
          <ScheduleFields
            form={form}
            onField={update}
            fieldErrors={fieldErrors}
            options={followOptions(tasks ?? [], null)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isSaving} disabled={!form.title.trim()}>
            Create task
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function describeChange(change, { peopleById, sprintsById, tasksById }) {
  if (change.field === 'review') return REVIEW_ACTIVITY_PHRASES[change.to ?? 'WITHDRAWN'] ?? change.to;
  const field = ACTIVITY_FIELD_LABELS[change.field] ?? change.field;
  const show = (value) => {
    if (value === null || value === undefined) return change.field === 'sprintId' ? 'Backlog' : 'none';
    if (change.field === 'status') return STATUS_LABELS[value] ?? value;
    if (change.field === 'assigneeId') return peopleById.get(value)?.name ?? 'someone';
    if (change.field === 'sprintId') return sprintsById.get(value)?.name ?? 'a sprint';
    if (change.field === 'startDate' || change.field === 'dueDate') return formatDate(value);
    if (change.field === 'dependsOnTaskId') return tasksById.get(value)?.key ?? 'another task';
    return String(value);
  };
  if (change.from === null && change.to === null && (change.field === 'title' || change.field === 'description')) {
    return `changed the ${field}`;
  }
  return `changed the ${field} from ${show(change.from)} to ${show(change.to)}`;
}

function ActivityLog({ activity, names }) {
  return (
    <ol className="space-y-3" aria-label="Activity">
      {activity.map((entry) => (
        <li key={entry.id} className="text-sm">
          <p className="text-slate-500">
            <span className="font-semibold text-slate-700">{entry.actor?.name ?? 'Someone'}</span>{' '}
            {entry.type === 'CREATED' && 'created the task'}
            {entry.type === 'COMMENTED' && 'commented'}
            {entry.type === 'UPDATED' && entry.changes.map((change) => describeChange(change, names)).join(', ')}
            {' · '}
            <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
          </p>
          {/* A comment, or the note a lead left with a review decision. */}
          {(entry.type === 'COMMENTED' || (entry.type === 'UPDATED' && entry.body)) && (
            <p className="mt-1 rounded-xl bg-slate-50 px-3 py-2 whitespace-pre-wrap text-slate-800 ring-1 ring-slate-200/70">
              {entry.body}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function formOf(task) {
  return {
    title: task.title,
    description: task.description ?? '',
    taskType: task.taskType,
    priority: task.priority,
    status: task.status,
    assigneeId: task.assignee?.id ?? UNASSIGNED,
    storyPoints: task.storyPoints === null ? '' : String(task.storyPoints),
    sprintId: task.sprintId ?? BACKLOG,
    startDate: task.startDate ?? '',
    dueDate: task.dueDate ?? '',
    dependsOnTaskId: task.dependsOnTaskId ?? NOT_FOLLOWING,
  };
}

/** Only what differs from the task, as the API takes it. */
function changesOf(form, task) {
  const saved = formOf(task);
  const changes = {};
  for (const field of ['title', 'description', 'taskType', 'priority', 'status']) {
    if (form[field] !== saved[field]) changes[field] = field === 'title' ? form.title.trim() : form[field];
  }
  if (form.assigneeId !== saved.assigneeId) changes.assigneeId = form.assigneeId || null;
  if (form.storyPoints !== saved.storyPoints) changes.storyPoints = pointsOf(form.storyPoints);
  if (form.sprintId !== saved.sprintId) changes.sprintId = form.sprintId === BACKLOG ? null : form.sprintId;
  for (const field of ['startDate', 'dueDate', 'dependsOnTaskId']) {
    if (form[field] !== saved[field]) changes[field] = form[field] || null;
  }
  return changes;
}

/** Why the status cannot be changed (or only so far), in the board's rules. */
function statusHint(task, rights) {
  if (task.status === TASK_STATUSES.IN_REVIEW && !rights.canMarkDone && rights.canMove) {
    return 'A task lead or its reporter marks it done';
  }
  if (!rights.canMove && !rights.canMarkDone) return 'Only its assignee or a task lead can move it';
  if (task.status !== TASK_STATUSES.IN_REVIEW && task.status !== TASK_STATUSES.DONE)
    return 'Done comes after In review';
  return undefined;
}

function TaskEditor({ departmentId, board, sprints, tasks, task, currentUserId, onSaved, onReload }) {
  const { csrfToken } = useAuth();
  const activeSprintId = sprints.find((sprint) => sprint.status === SPRINT_STATUSES.ACTIVE)?.id ?? null;
  const rights = taskRightsOf(task, board.viewer, currentUserId, activeSprintId);
  const statusChoices = allowedStatusesOf(task, rights);
  const [form, setForm] = useState(() => formOf(task));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const update = (field) => (changeEvent) => setForm({ ...form, [field]: changeEvent.target.value });
  const changes = changesOf(form, task);
  const hasChanges = Object.keys(changes).length > 0;
  const fieldErrors = saveError?.fieldErrors ?? {};
  // Leads choose any open sprint; an assignee can only bring a backlog task into the active sprint.
  const plannable = rights.canPlan
    ? sprints.filter((sprint) => sprint.status !== SPRINT_STATUSES.COMPLETED || sprint.id === task.sprintId)
    : sprints.filter((sprint) => sprint.id === activeSprintId && rights.canPullIntoSprint);
  const canChooseSprint = rights.canPlan || rights.canPullIntoSprint;

  async function save(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await requestTaskUpdate(departmentId, task.id, { ...changes, version: task.version }, csrfToken);
      onSaved(result.task, result.notice);
    } catch (updateError) {
      setSaveError(toDisplayError(updateError));
      if (updateError?.code === STALE_VERSION) onReload();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      {saveError && <Notice tone="error" title={saveError.message} />}
      <TextInput
        label="Title"
        value={form.title}
        onChange={update('title')}
        error={fieldErrors.title}
        maxLength={TASK_LIMITS.TITLE}
        disabled={!rights.canEdit}
        required
      />
      <TextArea
        label="Description"
        value={form.description}
        onChange={(description) => setForm({ ...form, description })}
        error={fieldErrors.description}
        maxLength={TASK_LIMITS.DESCRIPTION}
        disabled={!rights.canEdit}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectInput
          label="Status"
          value={form.status}
          onChange={update('status')}
          options={BOARD_COLUMNS.filter((column) => statusChoices.includes(column.status)).map((column) => ({
            value: column.status,
            label: column.label,
          }))}
          disabled={statusChoices.length <= 1}
          hint={statusHint(task, rights)}
        />
        <SelectInput
          label="Assignee"
          value={form.assigneeId}
          onChange={update('assigneeId')}
          error={fieldErrors.assigneeId}
          options={assigneeOptions(board.members)}
          disabled={!rights.canEdit}
        />
        <SelectInput
          label="Sprint"
          value={form.sprintId}
          onChange={update('sprintId')}
          error={fieldErrors.sprintId}
          options={sprintOptions(plannable)}
          disabled={!canChooseSprint}
        />
        <SelectInput
          label="Type"
          value={form.taskType}
          onChange={update('taskType')}
          options={TASK_TYPE_OPTIONS}
          disabled={!rights.canEdit}
        />
        <SelectInput
          label="Priority"
          value={form.priority}
          onChange={update('priority')}
          options={PRIORITY_OPTIONS}
          disabled={!rights.canEdit}
        />
        <TextInput
          label="Story points"
          type="number"
          min={0}
          max={TASK_LIMITS.STORY_POINTS}
          step={1}
          value={form.storyPoints}
          onChange={update('storyPoints')}
          error={fieldErrors.storyPoints}
          disabled={!rights.canEdit}
        />
        <ScheduleFields
          form={form}
          onField={update}
          fieldErrors={fieldErrors}
          options={followOptions(tasks, task.id)}
          disabled={!rights.canEdit}
        />
      </div>
      <p className="text-xs text-slate-500">
        Reported by {task.reporter?.name ?? 'someone'} · created {formatDateTime(task.createdAt)}
      </p>
      {(rights.canEdit || rights.canMove || rights.canMarkDone || canChooseSprint) && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setForm(formOf(task))} disabled={!hasChanges || isSaving}>
            Undo changes
          </Button>
          <Button type="submit" isBusy={isSaving} disabled={!hasChanges}>
            Save task
          </Button>
        </div>
      )}
    </form>
  );
}

/** A lead's decision on a task in review: approve it (Done), or send it back with a required note. */
function ReviewPanel({ departmentId, task, onSaved, onReload }) {
  const { csrfToken } = useAuth();
  const [isAskingForChanges, setIsAskingForChanges] = useState(false);
  const [note, setNote] = useState('');
  const [busyDecision, setBusyDecision] = useState(null);
  const [reviewError, setReviewError] = useState(null);

  async function decide(decision) {
    setBusyDecision(decision);
    setReviewError(null);
    try {
      const result = await requestTaskReview(
        departmentId,
        task.id,
        {
          decision,
          note: decision === TASK_REVIEW_DECISIONS.REQUEST_CHANGES ? note.trim() : null,
          version: task.version,
        },
        csrfToken,
      );
      onSaved(result.task, result.notice);
    } catch (decisionError) {
      setReviewError(toDisplayError(decisionError));
      if (decisionError?.code === STALE_VERSION) onReload();
    } finally {
      setBusyDecision(null);
    }
  }

  const submittedBy = task.review?.submittedBy?.name;
  return (
    <section aria-label="Review" className="space-y-3 rounded-xl bg-brand-50/60 p-4 ring-1 ring-brand-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-700">
          {submittedBy ? `${submittedBy} submitted this task for review` : 'This task is waiting for review'}
          {task.review?.submittedAt && <> · {formatDateTime(task.review.submittedAt)}</>}
        </p>
        {!isAskingForChanges && (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setIsAskingForChanges(true)} disabled={busyDecision !== null}>
              Request changes
            </Button>
            <Button
              onClick={() => decide(TASK_REVIEW_DECISIONS.APPROVE)}
              isBusy={busyDecision === TASK_REVIEW_DECISIONS.APPROVE}
              disabled={busyDecision !== null}
            >
              Approve
            </Button>
          </div>
        )}
      </div>
      {reviewError && <Notice tone="error" title={reviewError.message} />}
      {isAskingForChanges && (
        <div className="space-y-2">
          <TextArea
            label="What needs to change"
            value={note}
            onChange={setNote}
            error={reviewError?.fieldErrors?.note}
            maxLength={TASK_LIMITS.REVIEW_NOTE}
            rows={3}
            hint="Required: the assignee sees this note"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setIsAskingForChanges(false);
                setNote('');
              }}
              disabled={busyDecision !== null}
            >
              Cancel
            </Button>
            <Button
              onClick={() => decide(TASK_REVIEW_DECISIONS.REQUEST_CHANGES)}
              isBusy={busyDecision === TASK_REVIEW_DECISIONS.REQUEST_CHANGES}
              disabled={!note.trim() || busyDecision !== null}
            >
              Send back for changes
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The lead's note on a task sent back to In progress. */
function RevisionBanner({ review }) {
  return (
    <Notice tone="warning" title={`Revision requested by ${review.decidedBy?.name ?? 'a task lead'}`}>
      <p className="mt-1 whitespace-pre-wrap">{review.note}</p>
      {review.decidedAt && <p className="mt-1 text-xs opacity-80">{formatDateTime(review.decidedAt)}</p>}
    </Notice>
  );
}

/** A linked task, which opens in this dialog. */
function LinkedTask({ linked, onOpenTask }) {
  return (
    <button
      type="button"
      onClick={() => onOpenTask?.(linked.id)}
      className="text-left text-brand-700 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
    >
      <span className="font-mono">{linked.key}</span> {linked.title}
      <span className="text-slate-500"> · {STATUS_LABELS[linked.status] ?? linked.status}</span>
    </button>
  );
}

/** What this task follows, and the tasks that follow it. */
function LinkedTasks({ dependsOn, followedBy, onOpenTask }) {
  if (!dependsOn && followedBy.length === 0) return null;
  return (
    <dl className="space-y-1 text-sm" aria-label="Linked tasks">
      {dependsOn && (
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-600">Follows</dt>
          <dd>
            <LinkedTask linked={dependsOn} onOpenTask={onOpenTask} />
          </dd>
        </div>
      )}
      {followedBy.length > 0 && (
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-slate-600">Followed by</dt>
          {followedBy.map((linked) => (
            <dd key={linked.id}>
              <LinkedTask linked={linked} onOpenTask={onOpenTask} />
            </dd>
          ))}
        </div>
      )}
    </dl>
  );
}

function CommentBox({ departmentId, taskId, onCommented }) {
  const { csrfToken } = useAuth();
  const [body, setBody] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  async function send(submitEvent) {
    submitEvent.preventDefault();
    setIsSending(true);
    setSendError(null);
    try {
      await requestTaskComment(departmentId, taskId, body.trim(), csrfToken);
      setBody('');
      onCommented();
    } catch (commentError) {
      setSendError(toDisplayError(commentError));
    } finally {
      setIsSending(false);
    }
  }
  return (
    <form onSubmit={send} className="space-y-2">
      {sendError && <Notice tone="error" title={sendError.message} />}
      <TextArea label="Add a comment" value={body} onChange={setBody} maxLength={TASK_LIMITS.COMMENT} rows={3} />
      <div className="flex justify-end">
        <Button type="submit" isBusy={isSending} disabled={!body.trim()}>
          Comment
        </Button>
      </div>
    </form>
  );
}

/**
 * @param {{ departmentId: string, taskId: string, board: object, sprints: object[], tasks: object[],
 *   currentUserId: string, onChanged: (task) => void, onOpenTask?: (taskId) => void, onClose: () => void }} props
 */
export function TaskDetailDialog({
  departmentId,
  taskId,
  board,
  sprints,
  tasks = [],
  currentUserId,
  onChanged,
  onOpenTask,
  onClose,
}) {
  const taskResource = useApiResource((signal) => requestTask(departmentId, taskId, signal), [departmentId, taskId]);
  const [notice, setNotice] = useState(null);
  const data = taskResource.data;
  const peopleById = new Map([
    ...board.members.map((member) => [member.id, member]),
    ...(data ? [data.task.assignee, data.task.reporter].filter(Boolean).map((person) => [person.id, person]) : []),
  ]);
  const names = {
    peopleById,
    sprintsById: new Map(sprints.map((sprint) => [sprint.id, sprint])),
    tasksById: new Map(
      [...tasks, ...(data ? [data.dependsOn, ...(data.followedBy ?? [])].filter(Boolean) : [])].map((task) => [
        task.id,
        task,
      ]),
    ),
  };
  const revision = data ? revisionOf(data.task) : null;

  function saved(task, message) {
    setNotice(message ?? null);
    onChanged(task);
    taskResource.reload();
  }

  return (
    <Dialog title={data ? `${data.task.key} · ${data.task.title}` : 'Task'} onClose={onClose} size="lg">
      {taskResource.isLoading && !data && <LoadingBlock label="Loading the task…" />}
      {taskResource.error && <Notice tone="error" title={taskResource.error.message} />}
      {data && (
        <div className="space-y-6">
          {notice && <Notice tone="success" title={notice} onDismiss={() => setNotice(null)} />}
          {revision && <RevisionBanner review={revision} />}
          {canReviewTask(data.task, board.viewer) && (
            <ReviewPanel
              key={`review:${data.task.version}`}
              departmentId={departmentId}
              task={data.task}
              onSaved={saved}
              onReload={taskResource.reload}
            />
          )}
          <TaskEditor
            key={`${data.task.id}:${data.task.version}`}
            departmentId={departmentId}
            board={board}
            sprints={sprints}
            tasks={tasks}
            task={data.task}
            currentUserId={currentUserId}
            onSaved={saved}
            onReload={taskResource.reload}
          />
          <LinkedTasks dependsOn={data.dependsOn} followedBy={data.followedBy ?? []} onOpenTask={onOpenTask} />
          <section className="space-y-4 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-semibold text-slate-900">Activity</h3>
            <ActivityLog activity={data.activity} names={names} />
            <CommentBox departmentId={departmentId} taskId={data.task.id} onCommented={taskResource.reload} />
          </section>
        </div>
      )}
    </Dialog>
  );
}

/** @param {{ departmentId: string, onCreated: (sprint, notice) => void, onClose: () => void }} props */
export function SprintDialog({ departmentId, onCreated, onClose }) {
  const { csrfToken } = useAuth();
  const [form, setForm] = useState({ name: '', goal: '', startDate: '', endDate: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const update = (field) => (changeEvent) => setForm({ ...form, [field]: changeEvent.target.value });
  const fieldErrors = saveError?.fieldErrors ?? {};

  async function submit(submitEvent) {
    submitEvent.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await requestSprintCreation(departmentId, { ...form, name: form.name.trim() }, csrfToken);
      onCreated(result.sprint, result.notice);
    } catch (createError) {
      setSaveError(toDisplayError(createError));
      setIsSaving(false);
    }
  }

  return (
    <Dialog title="Plan a sprint" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {saveError && <Notice tone="error" title={saveError.message} />}
        <TextInput
          label="Sprint name"
          value={form.name}
          onChange={update('name')}
          error={fieldErrors.name}
          required
          data-autofocus
        />
        <TextArea
          label="Goal"
          value={form.goal}
          onChange={(goal) => setForm({ ...form, goal })}
          error={fieldErrors.goal}
          rows={2}
          hint="Optional"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Starts"
            type="date"
            value={form.startDate}
            onChange={update('startDate')}
            error={fieldErrors.startDate}
            required
          />
          <TextInput
            label="Ends"
            type="date"
            value={form.endDate}
            onChange={update('endDate')}
            error={fieldErrors.endDate}
            required
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" isBusy={isSaving}>
            Plan sprint
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
