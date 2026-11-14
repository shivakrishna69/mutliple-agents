/** Escapes text so it matches literally inside a RegExp (search input is never a pattern). */
export function escapeRegularExpression(searchText) {
  return searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
