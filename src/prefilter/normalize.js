// Shared category-string normalization: lowercase, trim, and collapse
// spaces/underscores to hyphens. Used by both canonicalCategory (to look up
// a source's raw category/topic in config/category_map.json) and
// destinationShortcut (to compare a rule's `category` against an event's, per
// the same normalization) so the two can never drift apart.

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeCategoryInput(value) {
  return String(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
}
