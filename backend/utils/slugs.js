/**
 * URL slugs: "Data Science & AI" -> "data-science-ai". Accents are dropped ("Café" -> "cafe");
 * anything that is not a letter or digit separates words.
 */

/** The slug of `text`, at most `maxLength` characters; `fallback` when nothing usable is left. */
export function slugify(text, { maxLength, fallback }) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return slug || fallback;
}

/**
 * `baseSlug`, or `baseSlug-2`, `-3`... : the first that `isTaken` says is free, kept within
 * `maxLength` by shortening the base.
 * @param {(slug: string) => Promise<boolean>} isTaken
 */
export async function firstFreeSlug(baseSlug, { maxLength, isTaken }) {
  if (!(await isTaken(baseSlug))) return baseSlug;
  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const suffix = `-${suffixNumber}`;
    const candidate = `${baseSlug.slice(0, maxLength - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
}
