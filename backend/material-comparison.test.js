/**
 * material-comparison.test.js
 * Plain Node.js tests — no external test framework required.
 * Run: node material-comparison.test.js
 */
import assert from "node:assert/strict";
import {
  computeMaterialAlternatives,
  calculateMaterialMass,
  calculateMaterialCost,
  calculateRelativeChange,
  buildTradeoff,
  buildWhyConsider,
  computeTradeoffScore,
} from "./material-comparison.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log("\n─── material-comparison.test.js ──────────────────────────");

// ---------------------------------------------------------------------------
// T6 & T7 — Pure formula helpers (no side effects)
// ---------------------------------------------------------------------------
console.log("\n[ Pure helpers ]");

test("T7a calculateMaterialMass — cylinder 196.35 cm³, mild steel 7.85 g/cm³ → 1.542 kg", () => {
  const mass = calculateMaterialMass(196.35, 7.85);
  assert.ok(Math.abs(mass - 1.5414) < 0.001, `Expected ~1.541 kg, got ${mass}`);
});

test("T7b calculateMaterialCost — 1.541 kg × ₹65/kg → ₹100 approx", () => {
  const cost = calculateMaterialCost(1.5414, 65);
  assert.ok(Math.abs(cost - 100.19) < 0.5, `Expected ~₹100, got ${cost}`);
});

test("T6a calculateRelativeChange — 0.50 vs 1.00 → -50%", () => {
  const pct = calculateRelativeChange(0.5, 1.0);
  assert.strictEqual(Math.round(pct), -50);
});

test("T6b calculateRelativeChange — 1.35 vs 1.00 → +35%", () => {
  const pct = calculateRelativeChange(1.35, 1.0);
  assert.strictEqual(Math.round(pct), 35);
});

test("T6c calculateRelativeChange — zero denominator returns 0", () => {
  assert.strictEqual(calculateRelativeChange(5, 0), 0);
});

// ---------------------------------------------------------------------------
// T1 — Mild steel baseline
// ---------------------------------------------------------------------------
console.log("\n[ T1 — Mild steel baseline (volumeCm3 = 100) ]");

const mildSteelMI = { volumeCm3: 100, quantity: 1 };
const mildSteelAnalysis = { materialEstimate: "mild steel" };
const t1 = computeMaterialAlternatives({
  analysis: mildSteelAnalysis,
  manufacturingIntelligence: mildSteelMI,
});

test("T1a — result is not an error", () => {
  assert.ok(!t1.error, `Got error: ${t1.error}`);
});

test("T1b — current material key is mild_steel", () => {
  assert.strictEqual(t1.current.key, "mild_steel");
});

test("T1c — current mass = 100 × 7.85 / 1000 = 0.785 kg", () => {
  assert.ok(Math.abs(t1.current.massKg - 0.785) < 0.001);
});

test("T1d — current material cost = 0.785 × 65 = ₹51 approx", () => {
  assert.ok(Math.abs(t1.current.materialCostINR - 51) < 2);
});

test("T1e — alternatives exist (up to 3)", () => {
  assert.ok(Array.isArray(t1.alternatives) && t1.alternatives.length > 0);
});

test("T1f — aluminium is lighter than mild steel", () => {
  const al = t1.alternatives.find((a) => a.key === "aluminium");
  assert.ok(al, "aluminium not in alternatives");
  assert.ok(al.weightChangePercent < 0, `Aluminium should be lighter, got ${al.weightChangePercent}%`);
});

test("T1g — stainless steel is more expensive (material cost) than mild steel", () => {
  const ss = t1.alternatives.find((a) => a.key === "stainless_steel");
  assert.ok(ss, "stainless_steel not in alternatives");
  assert.ok(
    ss.materialCostChangePercent > 0,
    `SS should cost more, got ${ss.materialCostChangePercent}%`
  );
});

test("T1h — cast iron mass < mild steel mass (lower density)", () => {
  const ci = t1.alternatives.find((a) => a.key === "cast_iron");
  assert.ok(ci, "cast_iron not in alternatives");
  // 7.2 < 7.85, so cast iron is lighter
  assert.ok(ci.massKg < t1.current.massKg, `CI should be lighter`);
});

test("T1i — no duplicate: current material not in alternatives", () => {
  const dup = t1.alternatives.find((a) => a.key === "mild_steel");
  assert.ok(!dup, "mild_steel should not appear in its own alternatives");
});

// ---------------------------------------------------------------------------
// T2 — Aluminium baseline
// ---------------------------------------------------------------------------
console.log("\n[ T2 — Aluminium baseline ]");

const alAnalysis = { materialEstimate: "aluminium" };
const t2 = computeMaterialAlternatives({
  analysis: alAnalysis,
  manufacturingIntelligence: mildSteelMI,
});

test("T2a — current is aluminium", () => {
  assert.strictEqual(t2.current.key, "aluminium");
});

test("T2b — mild steel is an alternative", () => {
  const ms = t2.alternatives.find((a) => a.key === "mild_steel");
  assert.ok(ms, "mild_steel should be an alternative for aluminium");
});

test("T2c — stainless steel is an alternative", () => {
  const ss = t2.alternatives.find((a) => a.key === "stainless_steel");
  assert.ok(ss, "stainless_steel should be an alternative for aluminium");
});

test("T2d — aluminium not in its own alternatives", () => {
  assert.ok(!t2.alternatives.find((a) => a.key === "aluminium"));
});

// ---------------------------------------------------------------------------
// T3 — Unknown material → fallback-default (mild steel)
// ---------------------------------------------------------------------------
console.log("\n[ T3 — Unknown material ]");

const t3 = computeMaterialAlternatives({
  analysis: { materialEstimate: "unknown" },
  manufacturingIntelligence: mildSteelMI,
});

test("T3a — no error returned", () => {
  assert.ok(!t3.error);
});

test("T3b — source is fallback-default", () => {
  assert.strictEqual(t3.current.materialSource, "fallback-default");
});

test("T3c — assumption is present (non-null)", () => {
  assert.ok(t3.current.assumption !== null);
});

test("T3d — alternatives still computed", () => {
  assert.ok(t3.alternatives.length > 0);
});

// ---------------------------------------------------------------------------
// T4 — Zero/negative volume → graceful error
// ---------------------------------------------------------------------------
console.log("\n[ T4 — Invalid volume ]");

const t4a = computeMaterialAlternatives({
  analysis: mildSteelAnalysis,
  manufacturingIntelligence: { volumeCm3: 0, quantity: 1 },
});
test("T4a — zero volumeCm3 → error shape", () => {
  assert.strictEqual(t4a.error, "insufficient-data");
});

const t4b = computeMaterialAlternatives({
  analysis: mildSteelAnalysis,
  manufacturingIntelligence: { volumeCm3: -50, quantity: 1 },
});
test("T4b — negative volumeCm3 → error shape", () => {
  assert.strictEqual(t4b.error, "insufficient-data");
});

const t4c = computeMaterialAlternatives({
  analysis: mildSteelAnalysis,
  manufacturingIntelligence: { volumeCm3: null, quantity: 1 },
});
test("T4c — null volumeCm3 → error shape (no throw)", () => {
  assert.strictEqual(t4c.error, "insufficient-data");
});

// ---------------------------------------------------------------------------
// T5 — Missing manufacturing intelligence
// ---------------------------------------------------------------------------
console.log("\n[ T5 — Missing manufacturingIntelligence ]");

const t5 = computeMaterialAlternatives({
  analysis: mildSteelAnalysis,
  manufacturingIntelligence: null,
});
test("T5 — null mfgIntelligence → error shape", () => {
  assert.strictEqual(t5.error, "insufficient-data");
});

// ---------------------------------------------------------------------------
// T8 — No duplicate materials (current not in alternatives)
// ---------------------------------------------------------------------------
console.log("\n[ T8 — No duplicate materials ]");

const KEYS = [
  "mild steel", "hardened steel", "stainless", "cast iron",
  "aluminium", "brass", "bronze", "plastic",
];
for (const mat of KEYS) {
  test(`T8 — ${mat}: not duplicated in alternatives`, () => {
    const result = computeMaterialAlternatives({
      analysis: { materialEstimate: mat },
      manufacturingIntelligence: { volumeCm3: 100, quantity: 1 },
    });
    if (result.error) return; // insufficient data is fine (e.g. plastic)
    const dup = result.alternatives.find((a) => a.key === result.current.key);
    assert.ok(!dup, `${result.current.key} appeared in its own alternatives`);
  });
}

// ---------------------------------------------------------------------------
// T9 — Plastic: no cross-category alternatives (empty list is OK)
// ---------------------------------------------------------------------------
console.log("\n[ T9 — Plastic — no alternatives in current DB ]");

const t9 = computeMaterialAlternatives({
  analysis: { materialEstimate: "plastic" },
  manufacturingIntelligence: { volumeCm3: 50, quantity: 1 },
});
test("T9a — no error for plastic", () => {
  assert.ok(!t9.error, `Unexpected error: ${t9.error}`);
});
test("T9b — alternatives array exists (may be empty)", () => {
  assert.ok(Array.isArray(t9.alternatives));
});
test("T9c — no metal in plastic alternatives", () => {
  const hasMetals = t9.alternatives.some(
    (a) => ["mild_steel", "aluminium", "stainless_steel"].includes(a.key)
  );
  assert.ok(!hasMetals, "Metals should not be alternatives for plastics");
});

// ---------------------------------------------------------------------------
// T6d — Aluminium vs mild steel: weight change should be ~-66%
// (density 2.7 vs 7.85 → 2.7/7.85 = 0.344, change = -65.6%)
// ---------------------------------------------------------------------------
console.log("\n[ T6d — Hand-checked aluminium vs mild steel percentage ]");

test("T6d — aluminium ~66% lighter than mild steel", () => {
  const expectedPct = Math.round(((2.7 - 7.85) / 7.85) * 100); // -66
  const al = t1.alternatives.find((a) => a.key === "aluminium");
  assert.strictEqual(al.weightChangePercent, expectedPct, 
    `Expected ${expectedPct}%, got ${al.weightChangePercent}%`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n─── Results: ${passed} passed, ${failed} failed ─────────────────`);
if (failed > 0) {
  process.exit(1);
}
