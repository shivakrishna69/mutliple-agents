/**
 * Turns the server's definitions ({ value, label, category }) into dropdown options that
 * SelectInput (components/ui.jsx) renders as <optgroup>s, groups in the order they first appear.
 * Definitions without a category become plain options.
 */
export function toGroupedOptions(definitions = []) {
  return definitions.map(({ value, label, category }) => ({ value, label, group: category ?? null }));
}

/**
 * The options split into consecutive groups: [{ group, options }], where `group` is null for
 * options outside any group. Options of one group are kept together even if they are not adjacent.
 */
export function groupsOf(options) {
  const groups = [];
  const groupByName = new Map();
  for (const option of options) {
    const groupName = option.group ?? null;
    if (!groupByName.has(groupName)) {
      const group = { group: groupName, options: [] };
      groupByName.set(groupName, group);
      groups.push(group);
    }
    groupByName.get(groupName).options.push(option);
  }
  return groups;
}

/** The label of `value` among `definitions`, or the value itself when it is not listed. */
export const labelOf = (definitions = [], value) =>
  definitions.find((definition) => definition.value === value)?.label ?? value;
