import assert from 'node:assert/strict';
import {
  resolveStreamSize,
  deriveMuxedConfidence,
  formatByteSize,
} from './src/services/formatPlanService.js';

console.log('=== Running Size Confidence & Formatting Tests ===\n');

// ── 1. Size Confidence Tests (Section 28) ──────────────────────────────────
console.log('1. Testing resolveStreamSize:');

// 1a. filesize -> exact
const s1 = resolveStreamSize({ filesize: 104857600 }, 60);
assert.equal(s1.confidence, 'exact');
assert.equal(s1.bytes, 104857600);
console.log('  [PASS] filesize -> exact');

// 1b. filesize_approx -> approximate
const s2 = resolveStreamSize({ filesize_approx: 52428800 }, 60);
assert.equal(s2.confidence, 'approximate');
assert.equal(s2.bytes, 52428800);
console.log('  [PASS] filesize_approx -> approximate');

// 1c. bitrate * duration -> calculated
const s3 = resolveStreamSize({ tbr: 2500 }, 120);
assert.equal(s3.confidence, 'calculated');
assert.equal(s3.bytes, Math.round((2500 * 1000 * 120) / 8));
console.log('  [PASS] bitrate * duration -> calculated');

// 1d. Invalid / zero / negative / NaN / null / undefined -> unavailable
const invalidCases = [
  { fmt: { filesize: 0 }, dur: 60, name: 'zero filesize' },
  { fmt: { filesize: -100 }, dur: 60, name: 'negative filesize' },
  { fmt: { filesize: NaN }, dur: 60, name: 'NaN filesize' },
  { fmt: { filesize_approx: 0 }, dur: 60, name: 'zero filesize_approx' },
  { fmt: { tbr: 0 }, dur: 60, name: 'zero bitrate' },
  { fmt: { tbr: -500 }, dur: 60, name: 'negative bitrate' },
  { fmt: { tbr: NaN }, dur: 60, name: 'NaN bitrate' },
  { fmt: { tbr: 2000 }, dur: 0, name: 'zero duration' },
  { fmt: { tbr: 2000 }, dur: -10, name: 'negative duration' },
  { fmt: { tbr: 2000 }, dur: NaN, name: 'NaN duration' },
  { fmt: null, dur: 60, name: 'null format' },
  { fmt: undefined, dur: 60, name: 'undefined format' },
  { fmt: {}, dur: 60, name: 'empty format object' },
];

for (const c of invalidCases) {
  const res = resolveStreamSize(c.fmt, c.dur);
  assert.equal(res.confidence, 'unavailable', `Failed for ${c.name}`);
  assert.equal(res.bytes, null, `Failed bytes for ${c.name}`);
}
console.log(`  [PASS] All ${invalidCases.length} invalid/zero cases resolved safely to 'unavailable'`);

// ── 2. Size Formatter Tests (Section 29) ────────────────────────────────────
console.log('\n2. Testing formatByteSize:');

// 2a. exact -> standard precision, no ~
const fExact = formatByteSize(92.4 * 1024 * 1024, 'exact');
assert.equal(fExact, '92.4 MB');
console.log(`  [PASS] exact: "${fExact}"`);

// 2b. approximate -> with ~ prefix
const fApprox = formatByteSize(92.4 * 1024 * 1024, 'approximate');
assert.equal(fApprox, '~92.4 MB');
console.log(`  [PASS] approximate: "${fApprox}"`);

// 2c. calculated -> intentionally limited precision: ~418 MB (no decimals for >= 10MB)
const fCalcLarge = formatByteSize(418.2 * 1024 * 1024, 'calculated');
assert.equal(fCalcLarge, '~418 MB');
console.log(`  [PASS] calculated (>=10MB): "${fCalcLarge}" (no false decimals)`);

// 2d. calculated (<10MB) -> reasonable precision retained
const fCalcSmall = formatByteSize(4.2 * 1024 * 1024, 'calculated');
assert.equal(fCalcSmall, '~4.2 MB');
console.log(`  [PASS] calculated (<10MB): "${fCalcSmall}"`);

// 2e. unavailable -> "Size unavailable" (never "0 MB", never "Unknown MB")
assert.equal(formatByteSize(0, 'unavailable'), 'Size unavailable');
assert.equal(formatByteSize(null, 'unavailable'), 'Size unavailable');
assert.equal(formatByteSize(NaN, 'calculated'), 'Size unavailable');
assert.equal(formatByteSize(-500, 'exact'), 'Size unavailable');
console.log('  [PASS] unavailable -> "Size unavailable" (no "0 MB")');

// ── 3. Output Confidence Tests (Section 30) ─────────────────────────────────
console.log('\n3. Testing Output Confidence Derivation:');

// Muxed rules:
// - calculated + anything -> calculated
assert.equal(deriveMuxedConfidence('calculated', 'exact'), 'calculated');
assert.equal(deriveMuxedConfidence('exact', 'calculated'), 'calculated');
assert.equal(deriveMuxedConfidence('calculated', 'approximate'), 'calculated');
assert.equal(deriveMuxedConfidence('calculated', 'calculated'), 'calculated');
console.log('  [PASS] muxed + calculated/anything -> calculated');

// - exact + exact -> approximate (cannot be byte-exact in advance)
assert.equal(deriveMuxedConfidence('exact', 'exact'), 'approximate');
console.log('  [PASS] muxed + exact/exact -> approximate (in advance)');

// - approximate + exact -> approximate
assert.equal(deriveMuxedConfidence('approximate', 'exact'), 'approximate');
assert.equal(deriveMuxedConfidence('exact', 'approximate'), 'approximate');
assert.equal(deriveMuxedConfidence('approximate', 'approximate'), 'approximate');
console.log('  [PASS] muxed + approximate/exact -> approximate');

// - unavailable + unavailable -> unavailable
assert.equal(deriveMuxedConfidence('unavailable', 'unavailable'), 'unavailable');
console.log('  [PASS] muxed + unavailable/unavailable -> unavailable');

// ── 4. Actual Size Difference Calculation (Section 31) ──────────────────────
console.log('\n4. Testing Actual Size Difference Calculation:');

function calculateDifference(actual, estimated) {
  if (
    typeof estimated !== 'number' ||
    !Number.isFinite(estimated) ||
    estimated <= 0 ||
    typeof actual !== 'number' ||
    !Number.isFinite(actual) ||
    actual <= 0
  ) {
    return { differenceBytes: null, differencePercent: null };
  }
  const differenceBytes = actual - estimated;
  const differencePercent = Math.abs(differenceBytes / estimated) * 100;
  return { differenceBytes, differencePercent: parseFloat(differencePercent.toFixed(2)) };
}

const testDiff = calculateDifference(291300000, 418000000);
assert.equal(testDiff.differenceBytes, -126700000);
assert.equal(testDiff.differencePercent, 30.31);
console.log(`  [PASS] 291.3MB vs 418.0MB -> diff: ${testDiff.differenceBytes} bytes, ${testDiff.differencePercent}%`);

// Zero and null safe checks
assert.deepEqual(calculateDifference(291300000, 0), { differenceBytes: null, differencePercent: null });
assert.deepEqual(calculateDifference(291300000, null), { differenceBytes: null, differencePercent: null });
assert.deepEqual(calculateDifference(null, 418000000), { differenceBytes: null, differencePercent: null });
assert.deepEqual(calculateDifference(0, 418000000), { differenceBytes: null, differencePercent: null });
assert.deepEqual(calculateDifference(NaN, 418000000), { differenceBytes: null, differencePercent: null });
console.log('  [PASS] zero/null/NaN safely handled without NaN or Infinity');

console.log('\n=== All Size Model Unit Tests PASSED Successfully! ===');
