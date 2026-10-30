/**
 * Gives departments created before slugs existed a unique slug from their name, and marks them
 * active. Departments that already have a slug are not touched.
 */

import { ORGANIZATION_FIELD_LIMITS } from '../constants/validation.js';
import Department from '../models/Department.js';
import { firstFreeSlug, slugify } from '../utils/slugs.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';

const SLUG_LIMITS = Object.freeze({ maxLength: ORGANIZATION_FIELD_LIMITS.DEPARTMENT_SLUG_MAX_LENGTH });

/** Another instance starting at the same moment may take the same slug first: then pick again. */
async function giveSlug(department) {
  const baseSlug = slugify(department.name, { ...SLUG_LIMITS, fallback: department.code.toLowerCase() });
  for (;;) {
    const slug = await firstFreeSlug(baseSlug, {
      ...SLUG_LIMITS,
      isTaken: (candidate) => Department.exists({ slug: candidate }).then(Boolean),
    });
    try {
      await Department.collection.updateOne({ _id: department._id, slug: { $exists: false } }, { $set: { slug } });
      return;
    } catch (updateError) {
      if (!isDuplicateKeyError(updateError)) throw updateError;
    }
  }
}

export default Object.freeze({
  name: 'add-department-slugs',
  async run() {
    const activated = await Department.updateMany({ isActive: { $exists: false } }, { $set: { isActive: true } });
    const departments = await Department.find({ slug: { $exists: false } })
      .select('name code')
      .sort({ createdAt: 1 })
      .lean();
    for (const department of departments) await giveSlug(department);
    return { changedCount: Math.max(activated.modifiedCount, departments.length) };
  },
});
