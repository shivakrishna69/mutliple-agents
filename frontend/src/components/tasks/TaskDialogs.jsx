/**
 * The task board's dialogs:
 *
 *   CreateTaskDialog   title, description, type, priority, assignee (people in the department),
 *                      story points; leads also choose the sprint (members' tasks go to the backlog)
 *   TaskDetailDialog   a task with its fields, status and sprint (each editable when the viewer may,
 *                      the same rules as the backend), its activity log and its comments
 *   SprintDialog       a new sprint: name, goal, start and end dates (leads)
 *
 * Every error is the backend's, shown in the dialog; an edit based on an old version reloads the task.
 */

import { useState } from 'react';
import {
  requestSprintCreation,
  requestTask,
  requestTaskComment,
  requestTaskCreation,
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
  SPRINT_STATUSES,
  STATUS_LABELS,
  TASK_LIMITS,
  TASK_STATUSES,
  TASK_TYPE_OPTIONS,
} from '../../constants/tasks.js';
import { toDisplayError, useApiResource } from '../../hooks/useApiResource.js';
import Dialog from '../Dialog.jsx';
import { Button, Field, LoadingBlock, Notice, SelectInput, TextInput, formatDateTime } from '../ui.jsx';
import { allowedStatusesOf, taskRightsOf } from '../../utils/taskBoard.js';

const UNASSIGNED = '';
const STALE_VERSION = 'STALE_VERSION';

const assigneeOptions = (members) => [
  { value: UNASSIGNED, label: 'Unassigned' },
  ...members.map((member) => ({ value: member.id, label: member.name })),
];
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
 * @param {{ departmentId: string, board: object, plannableSprints: object[], defaultSprintId: string|null,
 *   onCreated: (task, notice) => void, onClose: () => void }} props
 */
export function CreateTaskDialog({ departmentId, board, plannableSprints, defaultSprintId, onCreated, onClose }) {
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

function describeChange(change, peopleById, sprintsById) {
  const field = ACTIVITY_FIELD_LABELS[change.field] ?? change.field;
  const show = (value) => {
    if (value === null || value === undefined) return change.field === 'sprintId' ? 'Backlog' : 'none';
    if (change.field === 'status') return STATUS_LABELS[value] ?? value;
    if (change.field === 'assigneeId') return peopleById.get(value)?.name ?? 'someone';
    if (change.field === 'sprintId') return sprintsById.get(value)?.name ?? 'a sprint';
    return String(value);
  };
  if (change.from === null && change.to === null && (change.field === 'title' || change.field === 'description')) {
    return `changed the ${field}`;
  }
  return `changed the ${field} from ${show(change.from)} to ${show(change.to)}`;
}

function ActivityLog({ activity, peopleById, sprintsById }) {
  return (
    <ol className="space-y-3" aria-label="Activity">
      {activity.map((entry) => (
        <li key={entry.id} className="text-sm">
          <p className="text-slate-500">
            <span className="font-semibold text-slate-700">{entry.actor?.name ?? 'Someone'}</span>{' '}
            {entry.type === 'CREATED' && 'created the task'}
            {entry.type === 'COMMENTED' && 'commented'}
            {entry.type === 'UPDATED' &&
              entry.changes.map((change) => describeChange(change, peopleById, sprintsById)).join(', ')}
            {' · '}
            <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
          </p>
          {entry.type === 'COMMENTED' && (
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

function TaskEditor({ departmentId, board, sprints, task, currentUserId, onSaved, onReload }) {
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
 * @param {{ departmentId: string, taskId: string, board: object, sprints: object[], currentUserId: string,
 *   onChanged: (task) => void, onClose: () => void }} props
 */
export function TaskDetailDialog({ departmentId, taskId, board, sprints, currentUserId, onChanged, onClose }) {
  const taskResource = useApiResource((signal) => requestTask(departmentId, taskId, signal), [departmentId, taskId]);
  const [notice, setNotice] = useState(null);
  const data = taskResource.data;
  const peopleById = new Map([
    ...board.members.map((member) => [member.id, member]),
    ...(data ? [data.task.assignee, data.task.reporter].filter(Boolean).map((person) => [person.id, person]) : []),
  ]);
  const sprintsById = new Map(sprints.map((sprint) => [sprint.id, sprint]));

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
          <TaskEditor
            key={`${data.task.id}:${data.task.version}`}
            departmentId={departmentId}
            board={board}
            sprints={sprints}
            task={data.task}
            currentUserId={currentUserId}
            onSaved={saved}
            onReload={taskResource.reload}
          />
          <section className="space-y-4 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-semibold text-slate-900">Activity</h3>
            <ActivityLog activity={data.activity} peopleById={peopleById} sprintsById={sprintsById} />
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
