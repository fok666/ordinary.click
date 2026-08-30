// ordinary.click — Instant Catalog Search Engine
//
// Client-side multi-term search indexer and query matcher.
// Matches across photo tags, descriptions, filenames, collections, and locations.

/**
 * Tokenize a search query into normalized lowercase terms.
 * Handles both plain words and hashtags (#tag).
 * @param {string} query
 * @returns {Array<string>}
 */
export function tokenizeQuery(query) {
  if (!query || typeof query !== "string") return [];
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Build searchable text string for a photo object.
 * @param {object} photo
 * @param {Map<string, string>} [collectionTitles]
 * @returns {string}
 */
export function buildPhotoSearchText(photo, collectionTitles = new Map()) {
  const parts = [];

  // Tags
  const tags = photo.tags || photo.categories || [];
  parts.push(...tags);
  parts.push(...tags.map((t) => `#${t}`));

  // Description
  if (photo.description) {
    parts.push(photo.description);
  }

  // Filename
  if (photo.filename) {
    parts.push(photo.filename);
  }

  // Collection Title
  if (photo.collectionId && collectionTitles.has(photo.collectionId)) {
    parts.push(collectionTitles.get(photo.collectionId));
  }

  // Geo / place
  if (photo.latitude != null && photo.longitude != null) {
    parts.push(`${photo.latitude} ${photo.longitude}`);
  }

  return parts.join(" ").toLowerCase();
}

/**
 * Filter an array of photos by search query.
 * Matches multi-term queries with AND logic (all tokens must match).
 *
 * @param {Array<object>} photos
 * @param {string} query
 * @param {Map<string, string>} [collectionTitles]
 * @returns {Array<{ photo: object, score: number }>} Sorted by relevance score descending
 */
export function searchPhotos(photos, query, collectionTitles = new Map()) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length || !Array.isArray(photos)) {
    return [];
  }

  const results = [];

  for (const photo of photos) {
    const tags = (photo.tags || photo.categories || []).map((t) => t.toLowerCase());
    const desc = (photo.description || "").toLowerCase();
    const fname = (photo.filename || "").toLowerCase();
    const collTitle = (photo.collectionId && collectionTitles.get(photo.collectionId) || "").toLowerCase();
    const fullText = buildPhotoSearchText(photo, collectionTitles);

    let matchesAll = true;
    let score = 0;

    for (const token of tokens) {
      if (token.startsWith("#")) {
        const cleanTag = token.slice(1);
        const hasTag = tags.some((t) => t === cleanTag || t.includes(cleanTag));
        if (!hasTag && !desc.includes(token)) {
          matchesAll = false;
          break;
        }
        score += 20;
      } else {
        if (!fullText.includes(token)) {
          matchesAll = false;
          break;
        }

        // Scoring bonuses for precision
        if (tags.includes(token)) {
          score += 15;
        } else if (tags.some((t) => t.includes(token))) {
          score += 8;
        }
        if (desc.includes(token)) {
          score += 5;
        }
        if (fname.includes(token)) {
          score += 4;
        }
        if (collTitle.includes(token)) {
          score += 6;
        }
      }
    }

    if (matchesAll) {
      results.push({ photo, score });
    }
  }

  return results.sort((a, b) => b.score - a.score).map((r) => r.photo);
}

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);

/**
 * Highlight matched search words inside text.
 * Escapes HTML first to protect against XSS, then highlights tokens.
 *
 * @param {string} text
 * @param {string} query
 * @returns {string}
 */
export function highlightMatches(text, query) {
  if (!text) return "";
  const safeText = escapeHtml(text);
  const tokens = tokenizeQuery(query)
    .map((t) => t.replace(/^#/, ""))
    .filter((t) => t.length > 1);
  if (!tokens.length) return safeText;

  // Escape special regex characters in search tokens
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");

  return safeText.replace(regex, `<mark class="search-highlight">$1</mark>`);
}
