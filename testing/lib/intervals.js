/**
 * Interval-union helpers — the core compliance primitive.
 *
 * Used in two places with identical semantics:
 *   - Attendance: union a participant's join↔leave spans so reconnects don't
 *     double-count "present" time.
 *   - Watch tracking: union the spans of a recording a viewer ACTUALLY played,
 *     so seeking/scrubbing to the end can never inflate coverage.
 *
 * An interval is a two-element array [start, end] with start <= end, in seconds
 * (or epoch ms — the math is unit-agnostic). Zero-length and inverted intervals
 * are ignored.
 */

/**
 * Merge overlapping or adjacent intervals into a minimal, sorted, disjoint set.
 * @param {Array<[number, number]>} intervals
 * @returns {Array<[number, number]>}
 */
export function mergeIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return []

  // Keep only valid, positive-length intervals, then sort by start.
  const cleaned = intervals
    .filter(
      (iv) =>
        Array.isArray(iv) &&
        iv.length === 2 &&
        Number.isFinite(iv[0]) &&
        Number.isFinite(iv[1]) &&
        iv[1] > iv[0],
    )
    .map(([s, e]) => [s, e])
    .sort((a, b) => a[0] - b[0])

  if (cleaned.length === 0) return []

  const out = [[cleaned[0][0], cleaned[0][1]]]
  for (let i = 1; i < cleaned.length; i++) {
    const [start, end] = cleaned[i]
    const last = out[out.length - 1]
    if (start <= last[1]) {
      // overlap or adjacency → extend the current run
      last[1] = Math.max(last[1], end)
    } else {
      out.push([start, end])
    }
  }
  return out
}

/**
 * Total covered length of a set of intervals (after union).
 * @param {Array<[number, number]>} intervals
 * @returns {number} sum of merged interval lengths
 */
export function coveredSeconds(intervals) {
  return mergeIntervals(intervals).reduce((sum, [s, e]) => sum + (e - s), 0)
}

/**
 * Fraction of `total` covered by `intervals`, clamped to [0, 1].
 * Returns 0 when total is not a positive number.
 * @param {Array<[number, number]>} intervals
 * @param {number} total
 * @returns {number}
 */
export function coverageFraction(intervals, total) {
  if (!Number.isFinite(total) || total <= 0) return 0
  const covered = coveredSeconds(intervals)
  return Math.max(0, Math.min(1, covered / total))
}
