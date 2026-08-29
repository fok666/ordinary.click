// ordinary.click — Photo Sorting & Chronological Grouping
//
// Pure helper functions for sorting photos (by date, name, tag count)
// and clustering photos into timeline buckets for #/recent views.

/**
 * Sort an array of photo objects according to a sort strategy.
 * Returns a new sorted array without mutating input.
 *
 * @param {Array<object>} photos
 * @param {'date-desc'|'date-asc'|'name-asc'|'name-desc'|'tags-desc'} strategy
 * @returns {Array<object>}
 */
export function sortPhotos(photos, strategy = "date-desc") {
  if (!Array.isArray(photos)) return [];
  const list = [...photos];

  switch (strategy) {
    case "date-asc":
      return list.sort((a, b) => {
        const ta = a.createdAt || a.updatedAt || 0;
        const tb = b.createdAt || b.updatedAt || 0;
        return ta - tb;
      });

    case "name-asc":
      return list.sort((a, b) => {
        const na = (a.filename || a.description || a.id || "").toLowerCase();
        const nb = (b.filename || b.description || b.id || "").toLowerCase();
        return na.localeCompare(nb);
      });

    case "name-desc":
      return list.sort((a, b) => {
        const na = (a.filename || a.description || a.id || "").toLowerCase();
        const nb = (b.filename || b.description || b.id || "").toLowerCase();
        return nb.localeCompare(na);
      });

    case "tags-desc":
      return list.sort((a, b) => {
        const ta = (a.tags || a.categories || []).length;
        const tb = (b.tags || b.categories || []).length;
        return tb - ta;
      });

    case "date-desc":
    default:
      return list.sort((a, b) => {
        const ta = a.createdAt || a.updatedAt || 0;
        const tb = b.createdAt || b.updatedAt || 0;
        return tb - ta;
      });
  }
}

/**
 * Group photos by chronological time buckets (e.g. Today, This Week, Month Year).
 *
 * @param {Array<object>} photos
 * @param {number} [nowMs] - Optional reference time for testing
 * @returns {Array<{ label: string, photos: Array<object> }>}
 */
export function groupPhotosByDate(photos, nowMs = Date.now()) {
  if (!Array.isArray(photos) || !photos.length) return [];

  // Ensure sorted by date descending first
  const sorted = sortPhotos(photos, "date-desc");
  const groups = new Map();

  const oneDayMs = 86400 * 1000;
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - oneDayMs;
  const startOfSevenDays = startOfToday - 6 * oneDayMs;

  for (const photo of sorted) {
    const rawTs = photo.createdAt || photo.updatedAt || 0;
    // Handle seconds vs milliseconds timestamps
    const ts = rawTs < 10000000000 ? rawTs * 1000 : rawTs;
    const pDate = new Date(ts);

    let label = "";
    if (ts >= startOfToday) {
      label = "Today";
    } else if (ts >= startOfYesterday) {
      label = "Yesterday";
    } else if (ts >= startOfSevenDays) {
      label = "This Week";
    } else {
      label = pDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      if (label === "Invalid Date" || !ts) {
        label = "Earlier Moments";
      }
    }

    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(photo);
  }

  return Array.from(groups.entries()).map(([label, items]) => ({
    label,
    photos: items,
  }));
}
