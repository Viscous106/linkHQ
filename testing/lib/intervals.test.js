import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeIntervals, coveredSeconds, coverageFraction } from './intervals.js'

test('disjoint intervals stay disjoint', () => {
  assert.deepEqual(mergeIntervals([[0, 10], [20, 30]]), [[0, 10], [20, 30]])
})

test('overlapping intervals merge', () => {
  assert.deepEqual(mergeIntervals([[0, 10], [5, 15]]), [[0, 15]])
})

test('adjacent intervals merge (touching endpoints)', () => {
  assert.deepEqual(mergeIntervals([[0, 10], [10, 20]]), [[0, 20]])
})

test('unsorted input is handled', () => {
  assert.deepEqual(mergeIntervals([[20, 30], [0, 10], [5, 8]]), [[0, 10], [20, 30]])
})

test('fully nested interval is absorbed', () => {
  assert.deepEqual(mergeIntervals([[0, 100], [10, 20]]), [[0, 100]])
})

test('zero-length and inverted intervals are ignored', () => {
  assert.deepEqual(mergeIntervals([[5, 5], [10, 8], [0, 10]]), [[0, 10]])
})

test('empty / invalid input returns []', () => {
  assert.deepEqual(mergeIntervals([]), [])
  assert.deepEqual(mergeIntervals(null), [])
  assert.deepEqual(mergeIntervals([[1]]), [])
})

test('coveredSeconds sums merged lengths, not raw lengths', () => {
  // raw sum would be 10 + 10 = 20; union is [0,15] = 15
  assert.equal(coveredSeconds([[0, 10], [5, 15]]), 15)
})

test('THE compliance case: seek-to-end does NOT yield full coverage', () => {
  // Watched 0–5s, then scrubbed to the end and watched 90–100s of a 100s video.
  // Naive "currentTime / duration" would report 100%. Real coverage is 15%.
  const frac = coverageFraction([[0, 5], [90, 100]], 100)
  assert.equal(frac, 0.15)
})

test('coverageFraction clamps and guards bad totals', () => {
  assert.equal(coverageFraction([[0, 200]], 100), 1) // clamp to 1
  assert.equal(coverageFraction([[0, 10]], 0), 0) // bad total
  assert.equal(coverageFraction([], 100), 0)
})
