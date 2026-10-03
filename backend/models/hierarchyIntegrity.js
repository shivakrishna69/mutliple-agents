/**
 * Integrity checks for self-referencing hierarchies (the reporting chain in EmployeeProfile and
 * the department tree in Department).
 *
 * A schema validator can stop a document pointing at itself, but not a longer loop such as
 * A -> B -> C -> A. A loop would make every upward traversal ($graphLookup, "who is my skip-level
 * manager", "which division owns this team") either run to its depth limit or return nonsense,
 * so the models call `assertParentKeepsTreeAcyclic` whenever the parent pointer changes.
 *
 * Concurrency note: two simultaneous saves (A's parent set to B while B's parent is set to A) can
 * each pass this check and together create a loop. Hierarchy edits are rare admin actions; if
 * they become concurrent, run them inside a transaction or serialise them per organisation.
 */

/**
 * Throws when `proposedParentId` does not exist, or when making it the parent of `documentId`
 * would create a loop (the document would become its own ancestor).
 *
 * One $graphLookup starting at the proposed parent collects the parent and all of its ancestors
 * (up to `maxDepth`), served by the `_id` index. If `documentId` is among them, the change would
 * close a loop.
 *
 * @param {object}   options
 * @param {import('mongoose').Model} options.model  Model whose collection holds the hierarchy.
 * @param {import('mongoose').Types.ObjectId} options.documentId  The document being saved.
 * @param {import('mongoose').Types.ObjectId} options.proposedParentId  Its new parent.
 * @param {string}   options.parentFieldPath  Dotted path of the parent pointer, e.g. "parentDepartmentId".
 * @param {number}   options.maxDepth  Deepest ancestor level to walk.
 * @param {string}   options.entityLabel  Used in error messages, e.g. "Reporting manager".
 */
export async function assertParentKeepsTreeAcyclic({ model, documentId, proposedParentId, parentFieldPath, maxDepth, entityLabel }) {
  const [parentWithAncestors] = await model.aggregate([
    { $match: { _id: proposedParentId } },
    {
      $graphLookup: {
        from: model.collection.collectionName,
        startWith: `$${parentFieldPath}`,
        connectFromField: parentFieldPath,
        connectToField: '_id',
        as: 'ancestors',
        // maxDepth 0 means "the starting document's parent only", so subtract one level.
        maxDepth: Math.max(0, maxDepth - 1),
      },
    },
    { $project: { ancestorIds: '$ancestors._id' } },
  ]);

  if (!parentWithAncestors) {
    throw new Error(`${entityLabel} ${proposedParentId} does not exist`);
  }

  const chainIds = [parentWithAncestors._id, ...parentWithAncestors.ancestorIds];
  if (chainIds.some((chainId) => chainId.equals(documentId))) {
    throw new Error(`${entityLabel} ${proposedParentId} would create a loop in the hierarchy`);
  }
}

/** Throws when no document with `referencedId` exists in `model`'s collection. */
export async function assertReferenceExists({ model, referencedId, entityLabel }) {
  const referenceExists = await model.exists({ _id: referencedId });
  if (!referenceExists) {
    throw new Error(`${entityLabel} ${referencedId} does not exist`);
  }
}

/**
 * Query-style updates (updateOne, findOneAndUpdate, ...) skip document middleware, so they
 * would bypass the checks above. Returns a query hook that rejects any update touching one of
 * `guardedFieldPaths` (directly, or any parent / child path of it); such fields must be changed
 * by loading the document and calling save().
 */
export function createGuardedFieldUpdateBlocker(modelName, guardedFieldPaths) {
  const touchesGuardedPath = (updatePath) =>
    guardedFieldPaths.some((guardedPath) => updatePath === guardedPath || guardedPath.startsWith(`${updatePath}.`) || updatePath.startsWith(`${guardedPath}.`));

  return function blockGuardedFieldUpdates() {
    const update = this.getUpdate() ?? {};
    const updatePaths = Object.entries(update).flatMap(([updateKey, updateValue]) =>
      updateKey.startsWith('$') && updateValue && typeof updateValue === 'object' ? Object.keys(updateValue) : [updateKey],
    );
    const touchedPaths = [...new Set(updatePaths.filter(touchesGuardedPath))];
    if (touchedPaths.length > 0) {
      // A programming mistake, not a client error: it surfaces as HTTP 500.
      throw new Error(`${modelName} fields (${touchedPaths.join(', ')}) must be changed with save(), not a query update`);
    }
  };
}

export const QUERY_UPDATE_OPERATIONS = Object.freeze(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']);
