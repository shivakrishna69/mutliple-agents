/**
 * Shape checks shared by request validators whose field values are validated by a Mongoose model
 * (offices, leave types, leave settings): a JSON object, only known fields (anything else is
 * dropped), known fields inside nested groups, and the version an edit is based on.
 */

export const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** { isValid: true, sanitizedInput } or { isValid: false, validationErrors }. */
export function validationResult(validationErrors, sanitizedInput) {
  return validationErrors.length > 0 ? { isValid: false, validationErrors } : { isValid: true, sanitizedInput };
}

export const bodyNotObjectResult = () => validationResult([{ field: 'body', message: 'must be a JSON object' }]);

export function pickFields(source, fieldNames) {
  return Object.fromEntries(
    fieldNames
      .filter((fieldName) => source[fieldName] !== undefined)
      .map((fieldName) => [fieldName, source[fieldName]]),
  );
}

/**
 * The known top-level fields of a body, with each nested group reduced to its known fields.
 * @param {object} requestBody
 * @param {string[]} fieldNames  allowed top-level fields
 * @param {Record<string, string[]>} groupFieldNames  allowed fields of each nested group
 * @param {object[]} validationErrors  receives an error for a group that is not an object
 */
export function pickShapedFields(requestBody, fieldNames, groupFieldNames, validationErrors) {
  const fields = pickFields(requestBody, fieldNames);
  for (const [groupName, allowedGroupFields] of Object.entries(groupFieldNames)) {
    if (fields[groupName] === undefined) continue;
    if (!isPlainObject(fields[groupName])) {
      validationErrors.push({ field: groupName, message: 'must be an object' });
      delete fields[groupName];
    } else {
      fields[groupName] = pickFields(fields[groupName], allowedGroupFields);
    }
  }
  return fields;
}

/** True when the picked changes contain at least one value (a nested group counts when non-empty). */
export function hasChanges(changes) {
  return Object.values(changes).some((value) => !isPlainObject(value) || Object.keys(value).length > 0);
}

/** Adds an error unless `version` is the non-negative integer the client loaded. */
export function checkVersion(version, validationErrors) {
  if (!Number.isInteger(version) || version < 0) {
    validationErrors.push({ field: 'version', message: 'must be the version you loaded' });
  }
  return version;
}
