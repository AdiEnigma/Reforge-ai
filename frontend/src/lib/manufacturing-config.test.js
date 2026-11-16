import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  CATEGORY_IDS,
  CATEGORY_ORDER,
  CATEGORY_METADATA,
  MATERIAL_OPTIONS,
  PROCESS_OPTIONS,
  SURFACE_OPTIONS,
  TOLERANCE_OPTIONS,
  HEAT_TREATMENT_OPTIONS,
  INSPECTION_OPTIONS,
  PACKAGING_OPTIONS,
  getCategoryReasoning,
  evaluateTechnicalDependencies,
  computeConfiguratorStatuses,
  calculateLiveManufacturingSummary,
  computeSynchronizedManufacturingCost,
  loadManufacturingState,
  saveManufacturingState,
  resetManufacturingState,
} from './manufacturing-config.js';

describe('Manufacturing Configurator Suite', () => {
  it('1. Category order strictly matches the 9 sequential categories', () => {
    assert.strictEqual(CATEGORY_ORDER.length, 9);
    assert.strictEqual(CATEGORY_ORDER[0], CATEGORY_IDS.GEOMETRY);
    assert.strictEqual(CATEGORY_ORDER[1], CATEGORY_IDS.MATERIAL);
    assert.strictEqual(CATEGORY_ORDER[2], CATEGORY_IDS.PROCESS);
    assert.strictEqual(CATEGORY_ORDER[3], CATEGORY_IDS.SURFACE);
    assert.strictEqual(CATEGORY_ORDER[4], CATEGORY_IDS.TOLERANCES);
    assert.strictEqual(CATEGORY_ORDER[5], CATEGORY_IDS.HEAT_TREATMENT);
    assert.strictEqual(CATEGORY_ORDER[6], CATEGORY_IDS.INSPECTION);
    assert.strictEqual(CATEGORY_ORDER[7], CATEGORY_IDS.QUANTITY);
    assert.strictEqual(CATEGORY_ORDER[8], CATEGORY_IDS.PACKAGING);

    // Verify metadata numbers
    CATEGORY_ORDER.forEach((catId, index) => {
      assert.strictEqual(CATEGORY_METADATA[catId].num, index + 1);
    });
  });

  it('2. Status engine computes NOT STARTED, IN PROGRESS, CONFIRMED, and auto-advances', () => {
    // Initial state: nothing confirmed
    const emptyStatus = computeConfiguratorStatuses({}, {}, 'geometry', []);
    assert.strictEqual(emptyStatus.statuses.geometry, 'in_progress');
    assert.strictEqual(emptyStatus.statuses.material, 'not_started');
    assert.strictEqual(emptyStatus.confirmedCount, 0);
    assert.strictEqual(emptyStatus.isAllConfirmed, false);
    assert.strictEqual(emptyStatus.nextIncompleteCatId, 'geometry');

    // Confirm Category 01 (Geometry)
    const afterGeom = computeConfiguratorStatuses({}, { geometry: true }, 'material', []);
    assert.strictEqual(afterGeom.statuses.geometry, 'confirmed');
    assert.strictEqual(afterGeom.statuses.material, 'in_progress');
    assert.strictEqual(afterGeom.confirmedCount, 1);
    assert.strictEqual(afterGeom.nextIncompleteCatId, 'material');
  });

  it('3. Engineering dependencies detect technical incompatibilities and trigger NEEDS REVIEW', () => {
    // Case A: Aluminum + Case Carburizing
    const aluminumDecisions = {
      material: MATERIAL_OPTIONS.find((m) => m.id === 'al-7075-t6'),
      heatTreatment: HEAT_TREATMENT_OPTIONS.find((h) => h.id === 'case-carburizing'),
      surfaceTreatment: SURFACE_OPTIONS.find((s) => s.id === 'black-oxide'),
    };
    const deps = evaluateTechnicalDependencies(aluminumDecisions, 1);
    assert(deps.length >= 2);

    const htDep = deps.find((d) => d.target === CATEGORY_IDS.HEAT_TREATMENT);
    assert(htDep, 'Should flag heat treatment for aluminum');
    assert.strictEqual(htDep.severity, 'error');

    const surfDep = deps.find((d) => d.target === CATEGORY_IDS.SURFACE);
    assert(surfDep, 'Should flag black oxide for aluminum');

    // When both were previously confirmed, they must show NEEDS REVIEW
    const confirmedMap = { material: true, heatTreatment: true, surface: true };
    const statusWithIssues = computeConfiguratorStatuses(aluminumDecisions, confirmedMap, null, deps);
    assert.strictEqual(statusWithIssues.statuses.material, 'confirmed');
    assert.strictEqual(statusWithIssues.statuses.heatTreatment, 'needs_review');
    assert.strictEqual(statusWithIssues.statuses.surface, 'needs_review');
    assert.strictEqual(statusWithIssues.reviewCount, 2);
    assert.strictEqual(statusWithIssues.isAllConfirmed, false);
    // next incomplete should prioritize the first review issue
    assert.strictEqual(statusWithIssues.nextIncompleteCatId, 'surface');
  });

  it('4. Process and Tolerance dependencies (DIN 6 vs Hobbing)', () => {
    const decisions = {
      process: PROCESS_OPTIONS.find((p) => p.id === 'hobbing-cnc'),
      tolerances: TOLERANCE_OPTIONS.find((t) => t.id === 'iso-grade-6'),
    };
    const deps = evaluateTechnicalDependencies(decisions, 1);
    const procDep = deps.find((d) => d.target === CATEGORY_IDS.PROCESS);
    assert(procDep, 'Should flag hobbing when DIN 6 is chosen');
  });

  it('5. Geometry validation: Bore ID must be strictly less than OD', () => {
    const invalidGeom = {
      outerDiameter: 50,
      innerDiameter: 60,
    };
    const deps = evaluateTechnicalDependencies(invalidGeom, 1);
    const geomDep = deps.find((d) => d.target === CATEGORY_IDS.GEOMETRY);
    assert(geomDep);
    assert.strictEqual(geomDep.severity, 'error');
  });

  it('6. All 9 categories confirmed enables completion state', () => {
    const allConfirmedCats = {};
    CATEGORY_ORDER.forEach((id) => {
      allConfirmedCats[id] = true;
    });

    const validDecisions = {
      outerDiameter: 120,
      innerDiameter: 30,
      height: 28,
      teeth: 24,
      material: MATERIAL_OPTIONS[0], // AISI 4140
      process: PROCESS_OPTIONS[0], // Hobbing
      surfaceTreatment: SURFACE_OPTIONS[0], // Black oxide
      tolerances: TOLERANCE_OPTIONS[0], // DIN 7
      heatTreatment: HEAT_TREATMENT_OPTIONS[0], // Case carburizing
      inspection: INSPECTION_OPTIONS[0], // CMM
      packaging: PACKAGING_OPTIONS[0], // VCI
    };

    const deps = evaluateTechnicalDependencies(validDecisions, 10);
    assert.strictEqual(deps.length, 0);

    const fullStatus = computeConfiguratorStatuses(validDecisions, allConfirmedCats, null, deps);
    assert.strictEqual(fullStatus.confirmedCount, 9);
    assert.strictEqual(fullStatus.reviewCount, 0);
    assert.strictEqual(fullStatus.isAllConfirmed, true);
    assert.strictEqual(fullStatus.nextIncompleteCatId, null);

    // Verify live summary calculation
    const summary = calculateLiveManufacturingSummary(validDecisions, allConfirmedCats, 10);
    assert(summary.unitCostInr > 0);
    assert(summary.totalBatchCostInr > summary.unitCostInr);
    assert(summary.leadDays > 0);
  });

  it('7. Persistence engine serialization and reset', () => {
    const mockStore = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = v; },
      removeItem(k) { delete this._data[k]; },
    };

    saveManufacturingState({ outerDiameter: 140 }, { geometry: true }, mockStore);
    const loaded = loadManufacturingState(mockStore);
    assert.strictEqual(loaded.confirmedCategories.geometry, true);
    assert.strictEqual(loaded.decisions.outerDiameter, 140);

    resetManufacturingState(mockStore);
    const afterReset = loadManufacturingState(mockStore);
    assert.deepStrictEqual(afterReset.confirmedCategories, {});
  });

  it('8. All 9 fields initially remain unconfirmed and unvisited until explicit user confirmation', () => {
    // Fresh store
    const emptyStore = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = v; },
      removeItem(k) { delete this._data[k]; },
    };

    const initial = loadManufacturingState(emptyStore);
    assert.deepStrictEqual(initial.confirmedCategories, {}, 'All categories must initially be unconfirmed');

    // Statuses on initial load: Category 01 is expanded (in_progress), categories 02-09 are not_started
    const initStatus = computeConfiguratorStatuses({}, initial.confirmedCategories, 'geometry', []);
    assert.strictEqual(initStatus.confirmedCount, 0, 'Zero categories confirmed initially');
    assert.strictEqual(initStatus.statuses.geometry, 'in_progress');
    CATEGORY_ORDER.slice(1).forEach((catId) => {
      assert.strictEqual(initStatus.statuses[catId], 'not_started', `${catId} must be not_started initially`);
    });

    // When nothing is confirmed, technical dependencies for unconfirmed categories are not flagged as active review issues
    const decisionsWithConflict = {
      material: MATERIAL_OPTIONS.find((m) => m.id === 'al-7075-t6'),
      heatTreatment: HEAT_TREATMENT_OPTIONS.find((h) => h.id === 'case-carburizing'),
    };
    const activeDeps = evaluateTechnicalDependencies(decisionsWithConflict, 1, initial.confirmedCategories);
    assert.strictEqual(activeDeps.length, 0, 'No active dependency issues flagged when target categories are unconfirmed');

    // Only when user confirms does confirmedCategories change
    const afterConfirmingGeom = { geometry: true };
    const statusAfter01 = computeConfiguratorStatuses({}, afterConfirmingGeom, 'material', []);
    assert.strictEqual(statusAfter01.confirmedCount, 1);
    assert.strictEqual(statusAfter01.statuses.geometry, 'confirmed');
    assert.strictEqual(statusAfter01.statuses.material, 'in_progress');
  });

  it('9. Engineering decision reasoning generates comparative insights with structured points and verdict', () => {
    // Material comparison (AISI 4140)
    const matReasoning = getCategoryReasoning(
      CATEGORY_IDS.MATERIAL,
      MATERIAL_OPTIONS[0],
      { material: MATERIAL_OPTIONS[0] },
      10
    );
    assert(matReasoning);
    assert.strictEqual(matReasoning.verdictType, 'recommended');
    assert(matReasoning.points.length >= 3);
    assert(matReasoning.points.some((p) => p.label === 'Why Selected'));
    assert(matReasoning.points.some((p) => p.label === 'Comparative Trade-off'));

    // Process comparison (Hobbing vs alternatives)
    const procReasoning = getCategoryReasoning(
      CATEGORY_IDS.PROCESS,
      PROCESS_OPTIONS[0],
      { process: PROCESS_OPTIONS[0] },
      10
    );
    assert(procReasoning);
    assert(procReasoning.points.some((p) => p.label === 'Operational Impact'));

    // Verify all 8 options have costBadges
    [
      ...MATERIAL_OPTIONS,
      ...PROCESS_OPTIONS,
      ...SURFACE_OPTIONS,
      ...TOLERANCE_OPTIONS,
      ...HEAT_TREATMENT_OPTIONS,
      ...INSPECTION_OPTIONS,
      ...PACKAGING_OPTIONS,
    ].forEach((opt) => {
      assert(typeof opt.costBadge === 'string' && opt.costBadge.length > 0, `${opt.id} must have a costBadge`);
    });
  });

  it('10. Itemized Manufacturing Breakdown lists costs one-by-one as confirmed with ZERO discrepancy', () => {
    const decisions = {
      outerDiameter: 120,
      innerDiameter: 30,
      height: 32,
      teeth: 28,
      material: MATERIAL_OPTIONS.find((m) => m.id === 'aisi-4140'),
      process: PROCESS_OPTIONS.find((p) => p.id === 'grinding-finish'),
      surfaceTreatment: SURFACE_OPTIONS.find((s) => s.id === 'black-oxide'),
      tolerances: TOLERANCE_OPTIONS.find((t) => t.id === 'iso-grade-6'),
      heatTreatment: HEAT_TREATMENT_OPTIONS.find((h) => h.id === 'case-carburizing'),
      inspection: INSPECTION_OPTIONS.find((i) => i.id === 'cmm-lead-profile'),
      packaging: PACKAGING_OPTIONS.find((pk) => pk.id === 'vci-sealed'),
    };

    // When 0 categories confirmed:
    const emptyConfirmed = {};
    const costZero = computeSynchronizedManufacturingCost({
      decisions,
      confirmedCategories: emptyConfirmed,
      quantity: 5,
    });
    assert.strictEqual(costZero.confirmedCount, 0);
    assert.strictEqual(costZero.confirmedUnitCost, 0, 'Confirmed unit cost must be 0 when nothing is confirmed');
    assert.strictEqual(costZero.itemizedBreakdown.length, 9);
    costZero.itemizedBreakdown.forEach((row) => {
      assert.strictEqual(row.status, 'pending');
      assert.strictEqual(row.isConfirmed, false);
    });

    // Confirm 3 categories (Geometry, Material, Process)
    const confirmed3 = {
      [CATEGORY_IDS.GEOMETRY]: true,
      [CATEGORY_IDS.MATERIAL]: true,
      [CATEGORY_IDS.PROCESS]: true,
    };
    const cost3 = computeSynchronizedManufacturingCost({
      decisions,
      confirmedCategories: confirmed3,
      quantity: 5,
    });
    assert.strictEqual(cost3.confirmedCount, 3);
    assert(cost3.confirmedUnitCost > 0, 'Confirmed unit cost must reflect confirmed categories');

    // Confirm rows 1, 2, 3 must be confirmed; rows 4-9 must be pending
    const rowGeo = cost3.itemizedBreakdown.find((r) => r.catId === CATEGORY_IDS.GEOMETRY);
    const rowMat = cost3.itemizedBreakdown.find((r) => r.catId === CATEGORY_IDS.MATERIAL);
    const rowProc = cost3.itemizedBreakdown.find((r) => r.catId === CATEGORY_IDS.PROCESS);
    const rowSurf = cost3.itemizedBreakdown.find((r) => r.catId === CATEGORY_IDS.SURFACE);

    assert.strictEqual(rowGeo.isConfirmed, true);
    assert.strictEqual(rowMat.isConfirmed, true);
    assert.strictEqual(rowProc.isConfirmed, true);
    assert.strictEqual(rowSurf.isConfirmed, false);
    assert.strictEqual(rowSurf.status, 'pending');

    // Zero discrepancy check: calculateLiveManufacturingSummary vs computeSynchronizedManufacturingCost
    const liveSummary = calculateLiveManufacturingSummary(decisions, confirmed3, 5);
    assert.strictEqual(
      liveSummary.unitCostInr,
      cost3.unitCostInr,
      'Live summary unit cost must strictly equal synchronized cost unit cost'
    );
    assert.strictEqual(
      liveSummary.totalBatchCostInr,
      cost3.totalBatchCostInr,
      'Total batch cost must have zero discrepancy'
    );
  });

  it('11. Inter-panel communication: draft preview and live cost-impact explanation with engineering effects', () => {
    const decisions = {
      outerDiameter: 100,
      innerDiameter: 25,
      height: 28,
      teeth: 24,
      material: MATERIAL_OPTIONS[0],
      process: PROCESS_OPTIONS[0], // hobbing baseline
    };
    const confirmedCategories = {
      [CATEGORY_IDS.GEOMETRY]: true,
      [CATEGORY_IDS.MATERIAL]: true,
    };

    // User selects high-spec Process in configurator (CNC Hobbing + Post-Hardening Flank Grinding)
    const draftGrinding = PROCESS_OPTIONS.find((p) => p.id === 'grinding-finish');
    const previewState = computeSynchronizedManufacturingCost({
      decisions,
      confirmedCategories,
      quantity: 1,
      activeDraftSelection: {
        catId: CATEGORY_IDS.PROCESS,
        option: draftGrinding,
        isConfirmed: false,
      },
    });

    const exp = previewState.costImpactExplanation;
    assert(exp, 'Must generate cost impact explanation for selected draft option');
    assert.strictEqual(exp.catId, CATEGORY_IDS.PROCESS);
    assert.strictEqual(exp.isConfirmed, false);
    assert.strictEqual(exp.statusLabel, 'PREVIEW (PENDING CONFIRMATION)');
    assert(exp.deltaINR > 0, 'Flank grinding must calculate positive incremental cost delta');
    assert(exp.effectDesc.includes('grinding') || exp.effectDesc.includes('distortion'), 'Must contain actual engineering effect explanation');
    assert(exp.actionHint.includes('preview'), 'Action hint must instruct user that selection is a preview before confirmation');

    // Itemized breakdown row for process must be labeled as PREVIEW
    const procRow = previewState.itemizedBreakdown.find((r) => r.catId === CATEGORY_IDS.PROCESS);
    assert.strictEqual(procRow.status, 'preview');
    assert.strictEqual(procRow.isPreview, true);
    assert.strictEqual(procRow.isConfirmed, false);

    // After confirmation:
    const confirmedState = computeSynchronizedManufacturingCost({
      decisions: { ...decisions, process: draftGrinding },
      confirmedCategories: { ...confirmedCategories, [CATEGORY_IDS.PROCESS]: true },
      quantity: 1,
      activeDraftSelection: {
        catId: CATEGORY_IDS.PROCESS,
        option: draftGrinding,
        isConfirmed: true,
      },
    });

    const confExp = confirmedState.costImpactExplanation;
    assert.strictEqual(confExp.isConfirmed, true);
    assert.strictEqual(confExp.statusLabel, 'CONFIRMED & APPLIED');
    assert(confirmedState.confirmedUnitCost > previewState.confirmedUnitCost, 'Confirmed cost must incorporate the new choice');
    assert(confirmedState.lifecycleTco.tenYearTcoINR > 0, 'TCO must be computed dynamically');
  });
});
