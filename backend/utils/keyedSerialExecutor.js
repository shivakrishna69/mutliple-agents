/**
 * Runs async tasks one at a time per key, while tasks for different keys run in parallel.
 *
 * The webhook flow uses the customer id as the key, so two messages from the same customer
 * arriving together are processed in arrival order. Without this, both could see "no
 * conversation" and create two, or both could call the AI with a history missing the other
 * message and then race to update the conversation's state.
 *
 * Mechanism: each key maps to the promise of the last queued task (the "tail"). A new task
 * waits for the current tail, then runs; its own completion becomes the new tail. Tails never
 * reject, so one failing task does not block or fail the tasks queued behind it. When the last
 * task for a key finishes, the key is removed, so memory is proportional to keys in use.
 *
 * Scope: this serialises within one Node.js process. With several backend instances, two
 * deliveries for the same customer could land on different instances; the Conversation
 * model's optimistic concurrency then turns a conflicting state write into a VersionError
 * instead of corrupt state. Move to a distributed lock or per-customer queue before scaling out.
 */

export function createKeyedSerialExecutor() {
  /** key -> promise that resolves when the most recently queued task for that key finishes */
  const taskTailsByKey = new Map();

  /**
   * Queues `task` behind any running or queued task for `key` and resolves or rejects with its result.
   * @template TaskResult
   * @param {string} key
   * @param {() => Promise<TaskResult>} task
   * @returns {Promise<TaskResult>}
   */
  return async function runExclusively(key, task) {
    const previousTaskTail = taskTailsByKey.get(key) ?? Promise.resolve();

    let markCurrentTaskFinished;
    const currentTaskFinished = new Promise((resolve) => {
      markCurrentTaskFinished = resolve;
    });
    const newTaskTail = previousTaskTail.then(() => currentTaskFinished);
    taskTailsByKey.set(key, newTaskTail);

    try {
      await previousTaskTail;
      return await task();
    } finally {
      markCurrentTaskFinished();
      if (taskTailsByKey.get(key) === newTaskTail) {
        taskTailsByKey.delete(key);
      }
    }
  };
}
