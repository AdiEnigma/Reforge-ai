import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
  QUANTITY_TIERS,
  PACKAGING_OPTIONS,
  getInitialDraftDecisions,
  getCategoryReasoning,
  evaluateTechnicalDependencies,
  computeConfiguratorStatuses,
  calculateLiveManufacturingSummary,
  loadManufacturingState,
  saveManufacturingState,
  resetManufacturingState,
} from '../lib/manufacturing-config.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

function EngineeringReasoningCard({ catId, selectedOption, draftDecisions, quantity, analysis }) {
  const reasoning = useMemo(() => {
    return getCategoryReasoning(catId, selectedOption, draftDecisions, quantity, analysis);
  }, [catId, selectedOption, draftDecisions, quantity, analysis]);

  if (!reasoning || !reasoning.points || reasoning.points.length === 0) return null;

  const isWarn = reasoning.verdictType === 'suboptimal';

  return (
    <div className={`mfg-reasoning-card ${isWarn ? 'suboptimal' : ''}`} role="region" aria-label={reasoning.title}>
      <div className="mfg-reasoning-head">
        <div className="mfg-reasoning-title-group">
          <Icon className="reasoning-icon">{isWarn ? 'info' : 'verified'}</Icon>
          <strong className="mfg-reasoning-title">{reasoning.title}</strong>
        </div>
        <span className={`mfg-reasoning-verdict ${isWarn ? 'warn' : ''}`}>
          {reasoning.verdict}
        </span>
      </div>
      <ul className="mfg-reasoning-points">
        {reasoning.points.map((pt, idx) => (
          <li key={idx} className="mfg-reasoning-point">
            <strong className="reasoning-point-label">{pt.label}:</strong>{' '}
            <span className="reasoning-point-text">{pt.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatINR(n) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

export function ManufacturingDecisionPanel({
  isOpen,
  onClose,
  width,
  onResize,
  // Customization & Docking
  isDocked = true,
  onToggleDock,
  isMaximized = false,
  onToggleMaximize,
  isFloatingContent = false,
  currentSlot = 'right',
  onMoveSlot,
  onStartDrag,
  // Engineering Props
  analysis,
  decisions: propDecisions,
  onChangeDecision,
  dependencies: externalDependencies = [],
  quantity: propQuantity = 1,
  onChangeQuantity,
  onOpenReport,
  // Two-way Inter-Panel Sync
  onDraftSelect,
  onConfirmedCategoriesChange,
}) {
  // ─── Local State for Sequential Configuration ───────────────────────────────
  const [persistedState, setPersistedState] = useState(() => loadManufacturingState());
  const [confirmedCategories, setConfirmedCategories] = useState(() => {
    const loaded = loadManufacturingState();
    return loaded.confirmedCategories || {};
  });

  // Confirmed decisions (synced with parent / localStorage)
  const [confirmedDecisions, setConfirmedDecisions] = useState(() => {
    const loaded = loadManufacturingState();
    const initial = getInitialDraftDecisions(analysis);
    return {
      ...initial,
      ...(propDecisions || {}),
      ...(loaded.decisions || {}),
    };
  });

  // Draft decisions currently being edited in the open category before explicit confirmation
  const [draftDecisions, setDraftDecisions] = useState(() => ({
    ...confirmedDecisions,
  }));

  // Batch Quantity state
  const [draftQuantity, setDraftQuantity] = useState(propQuantity || 1);

  // Expand first incomplete category by default (e.g. Category 01 Geometry for new configuration)
  const [expandedCat, setExpandedCat] = useState(() => {
    const loaded = loadManufacturingState();
    const confirmed = loaded.confirmedCategories || {};
    const firstIncomplete = CATEGORY_ORDER.find((id) => !confirmed[id]);
    return firstIncomplete || CATEGORY_IDS.GEOMETRY;
  });

  const isDraggingResizerRef = useRef(false);

  // Sync with analysis if analysis changes and geometry hasn't been confirmed yet
  useEffect(() => {
    if (analysis && !confirmedCategories[CATEGORY_IDS.GEOMETRY]) {
      const initial = getInitialDraftDecisions(analysis);
      setDraftDecisions((prev) => ({
        ...prev,
        outerDiameter: initial.outerDiameter,
        innerDiameter: initial.innerDiameter,
        height: initial.height,
        teeth: initial.teeth,
      }));
    }
  }, [analysis, confirmedCategories]);

  // Sync propDecisions changes from external source if any
  useEffect(() => {
    if (propDecisions && Object.keys(propDecisions).length > 0) {
      setConfirmedDecisions((prev) => ({ ...prev, ...propDecisions }));
    }
  }, [propDecisions]);

  // ─── Technical Dependency Evaluation ─────────────────────────────────────────
  const internalDependencies = useMemo(() => {
    return evaluateTechnicalDependencies(confirmedDecisions, propQuantity, confirmedCategories);
  }, [confirmedDecisions, propQuantity, confirmedCategories]);

  // Combined dependencies (internal technical rules + any external rules)
  const allDependencies = useMemo(() => {
    const combined = [...internalDependencies];
    externalDependencies.forEach((ext) => {
      if (confirmedCategories[ext.target]) {
        if (!combined.some((d) => d.target === ext.target && d.title === ext.title)) {
          combined.push(ext);
        }
      }
    });
    return combined;
  }, [internalDependencies, externalDependencies, confirmedCategories]);

  // Status computation for all 9 categories (NOT STARTED, IN PROGRESS, CONFIRMED, NEEDS REVIEW)
  const { statuses, confirmedCount, reviewCount, isAllConfirmed, nextIncompleteCatId } = useMemo(() => {
    return computeConfiguratorStatuses(confirmedDecisions, confirmedCategories, expandedCat, allDependencies);
  }, [confirmedDecisions, confirmedCategories, expandedCat, allDependencies]);

  // Live estimated cost and lead time
  const liveSummary = useMemo(() => {
    try {
      return calculateLiveManufacturingSummary(confirmedDecisions, confirmedCategories, propQuantity) || {
        unitCostInr: 21606,
        totalBatchCostInr: 21606 * (propQuantity || 1),
        leadDays: 22,
      };
    } catch (err) {
      console.warn('Error in liveSummary calculation:', err);
      return {
        unitCostInr: 21606,
        totalBatchCostInr: 21606 * (propQuantity || 1),
        leadDays: 22,
      };
    }
  }, [confirmedDecisions, confirmedCategories, propQuantity]);

  // Persist state safely to storage on changes
  useEffect(() => {
    saveManufacturingState(confirmedDecisions, confirmedCategories);
  }, [confirmedDecisions, confirmedCategories]);

  // ─── Two-Way Inter-Panel Communication Helpers ─────────────────────────────
  const handleSelectOptionDraft = (catId, option) => {
    setDraftDecisions((d) => ({ ...d, [catId]: option }));
    onDraftSelect?.({
      catId,
      option,
      isConfirmed: false,
    });
  };

  const handleSelectQuantityDraft = (q) => {
    setDraftQuantity(q);
    onDraftSelect?.({
      catId: CATEGORY_IDS.QUANTITY,
      option: { id: `qty-${q}`, label: `Batch of ${q} units` },
      quantity: q,
      isConfirmed: false,
    });
  };

  const handleUpdateGeometryDraft = (field, val) => {
    setDraftDecisions((d) => {
      const next = { ...d, [field]: val };
      onDraftSelect?.({
        catId: CATEGORY_IDS.GEOMETRY,
        option: { id: 'custom-geometry', label: `OD: ${next.outerDiameter}mm · ID: ${next.innerDiameter}mm · L: ${next.height}mm` },
        isConfirmed: false,
      });
      return next;
    });
  };

  // Sync active draft with Cost Panel when expanded category changes
  useEffect(() => {
    if (expandedCat) {
      const opt = draftDecisions[expandedCat] || confirmedDecisions[expandedCat];
      onDraftSelect?.({
        catId: expandedCat,
        option: opt,
        isConfirmed: Boolean(confirmedCategories[expandedCat]),
      });
    }
  }, [expandedCat, onDraftSelect]);

  // ─── User Actions: Confirm Selection & Auto-Advance ─────────────────────────
  const handleConfirmCategory = useCallback((catId) => {
    // 1. Save draft decision for this category into confirmed decisions
    let nextConfirmed = { ...confirmedDecisions };

    if (catId === CATEGORY_IDS.GEOMETRY) {
      nextConfirmed = {
        ...nextConfirmed,
        outerDiameter: draftDecisions.outerDiameter,
        innerDiameter: draftDecisions.innerDiameter,
        height: draftDecisions.height,
        teeth: draftDecisions.teeth,
      };
      onChangeDecision?.('outerDiameter', draftDecisions.outerDiameter);
      onChangeDecision?.('innerDiameter', draftDecisions.innerDiameter);
      onChangeDecision?.('height', draftDecisions.height);
      onChangeDecision?.('teeth', draftDecisions.teeth);
    } else if (catId === CATEGORY_IDS.QUANTITY) {
      onChangeQuantity?.(draftQuantity);
    } else {
      nextConfirmed = {
        ...nextConfirmed,
        [catId]: draftDecisions[catId],
      };
      onChangeDecision?.(catId, draftDecisions[catId]);
    }

    // 2. Mark this category as confirmed
    const nextConfirmedCats = {
      ...confirmedCategories,
      [catId]: true,
    };

    setConfirmedDecisions(nextConfirmed);
    setConfirmedCategories(nextConfirmedCats);
    saveManufacturingState(nextConfirmed, nextConfirmedCats);
    onConfirmedCategoriesChange?.(nextConfirmedCats);

    const confirmedOpt = catId === CATEGORY_IDS.QUANTITY
      ? { id: `qty-${draftQuantity}`, label: `Batch of ${draftQuantity} units` }
      : nextConfirmed[catId] || draftDecisions[catId];

    onDraftSelect?.({
      catId,
      option: confirmedOpt,
      isConfirmed: true,
    });

    // 3. Re-evaluate dependencies with newly confirmed selection
    const nextDeps = evaluateTechnicalDependencies(nextConfirmed, draftQuantity, nextConfirmedCats);

    // 4. Determine next category to auto-expand
    const nextStatus = computeConfiguratorStatuses(nextConfirmed, nextConfirmedCats, null, nextDeps);

    if (nextStatus.nextIncompleteCatId) {
      setExpandedCat(nextStatus.nextIncompleteCatId);
      // Pre-fill draft with current confirmed or sensible option if empty
      setDraftDecisions((d) => ({
        ...d,
        [nextStatus.nextIncompleteCatId]: nextConfirmed[nextStatus.nextIncompleteCatId] || d[nextStatus.nextIncompleteCatId],
      }));
    } else {
      // All 9 are confirmed! Keep current collapsed or show complete summary
      setExpandedCat(null);
    }
  }, [confirmedDecisions, draftDecisions, confirmedCategories, draftQuantity, onChangeDecision, onChangeQuantity, onConfirmedCategoriesChange, onDraftSelect]);

  // Reset entire configuration back to Category 01 unconfirmed
  const handleResetConfiguration = useCallback(() => {
    resetManufacturingState();
    setConfirmedCategories({});
    const initial = getInitialDraftDecisions(analysis);
    setConfirmedDecisions(initial);
    setDraftDecisions(initial);
    setExpandedCat(CATEGORY_IDS.GEOMETRY);
    onConfirmedCategoriesChange?.({});
    onDraftSelect?.({
      catId: CATEGORY_IDS.GEOMETRY,
      option: { id: 'custom-geometry', label: `OD: ${initial.outerDiameter}mm · ID: ${initial.innerDiameter}mm` },
      isConfirmed: false,
    });
  }, [analysis, onConfirmedCategoriesChange, onDraftSelect]);

  // Jump to next pending or review category
  const handleJumpToNext = useCallback(() => {
    if (nextIncompleteCatId) {
      setExpandedCat(nextIncompleteCatId);
    }
  }, [nextIncompleteCatId]);

  // Drag resizer handle for width adjustment
  const handleMouseDownResizer = (e) => {
    e.preventDefault();
    isDraggingResizerRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent) => {
      if (!isDraggingResizerRef.current) return;
      const maxW = Math.max(320, window.innerWidth - 380);
      const newWidth = Math.max(320, Math.min(Math.min(1400, maxW), window.innerWidth - moveEvent.clientX));
      onResize?.(newWidth);
    };

    const onMouseUp = () => {
      isDraggingResizerRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onMouseUp);
  };

  if (!isOpen) return null;

  // ─── Render Helper: Summary Text for Category Row ────────────────────────────
  const getCategorySummary = (catId) => {
    const isConf = Boolean(confirmedCategories[catId]);
    if (!isConf) {
      if (expandedCat === catId) {
        if (catId === CATEGORY_IDS.GEOMETRY) {
          return 'In progress · Specify dimensions and confirm below';
        }
        return 'In progress · Select an option and confirm below';
      }
      return 'Not yet configured · Click to specify';
    }

    const dec = confirmedDecisions;
    switch (catId) {
      case CATEGORY_IDS.GEOMETRY:
        return `OD: ${dec.outerDiameter || 100}mm · ID: ${dec.innerDiameter || 25}mm · L: ${dec.height || 28}mm (${dec.teeth || 24}T)`;
      case CATEGORY_IDS.MATERIAL:
        return dec.material?.label || 'Awaiting material selection...';
      case CATEGORY_IDS.PROCESS:
        return dec.process?.label || 'Awaiting process route...';
      case CATEGORY_IDS.SURFACE:
        return dec.surfaceTreatment?.label || 'Awaiting surface treatment...';
      case CATEGORY_IDS.TOLERANCES:
        return dec.tolerances?.label || 'Awaiting precision tolerance class...';
      case CATEGORY_IDS.HEAT_TREATMENT:
        return dec.heatTreatment?.label || 'Awaiting thermal treatment...';
      case CATEGORY_IDS.INSPECTION:
        return dec.inspection?.label || 'Awaiting metrology protocol...';
      case CATEGORY_IDS.QUANTITY:
        return `${propQuantity} unit${propQuantity === 1 ? '' : 's'} (Production Batch)`;
      case CATEGORY_IDS.PACKAGING:
        return dec.packaging?.label || 'Awaiting preservation packaging...';
      default:
        return 'Not configured';
    }
  };

  return (
    <aside
      className={`mfg-decision-panel ${isMaximized ? 'maximized' : ''} ${isFloatingContent ? 'in-floating' : ''}`}
      style={isFloatingContent || isMaximized ? undefined : { width: `${width}px` }}
      aria-label="Guided Sequential Manufacturing Decision Configurator"
    >
      {/* ─── Top Configurator Header ───────────────────────────────────────── */}
      <div className="mfg-decision-header">
        <div className="mfg-decision-title-group">
          <Icon className="mfg-header-icon">tune</Icon>
          <div>
            <h2 className="mfg-decision-title">MANUFACTURING CONFIGURATOR</h2>
            <span className="mfg-decision-sub">
              {confirmedCount} of 9 Confirmed · {isAllConfirmed ? 'Ready for Report' : confirmedCount === 0 ? 'Not Started' : 'In Progress'}
            </span>
          </div>
        </div>

        <div className="panel-header-actions">
          {onStartDrag && (
            <button
              type="button"
              className="panel-action-btn panel-drag-handle"
              onMouseDown={onStartDrag}
              title="Dock button: Drag and drop into any panel area (Left, Center, Right, Bottom)"
              aria-label="Dock and drag Manufacturing Panel"
            >
              <Icon>drag_indicator</Icon>
            </button>
          )}

          {onToggleMaximize && (
            <button
              type="button"
              className="panel-action-btn"
              onClick={onToggleMaximize}
              title={isMaximized ? "Restore panel size" : "Maximize panel"}
              aria-label={isMaximized ? "Restore Manufacturing Panel" : "Maximize Manufacturing Panel"}
            >
              <Icon>{isMaximized ? 'fullscreen_exit' : 'fullscreen'}</Icon>
            </button>
          )}

          <button
            type="button"
            className="panel-action-btn close-btn"
            onClick={onClose}
            title="Close Manufacturing Panel"
            aria-label="Close Manufacturing Panel"
          >
            <Icon>close</Icon>
          </button>
        </div>
      </div>

      {/* ─── Progress & Live Cost Strip ─────────────────────────────────────── */}
      <div className="mfg-progress-strip">
        <div className="mfg-progress-meta">
          <div className="mfg-progress-track-9seg" aria-label="Configuration progress: 9 steps">
            {CATEGORY_ORDER.map((id, idx) => {
              const status = statuses[id];
              let segClass = 'seg-not-started';
              if (status === 'confirmed') segClass = 'seg-confirmed';
              else if (status === 'needs_review') segClass = 'seg-review';
              else if (expandedCat === id) segClass = 'seg-active';

              return (
                <div
                  key={id}
                  className={`mfg-seg-pill ${segClass}`}
                  title={`Step 0${idx + 1}: ${CATEGORY_METADATA[id].title} (${status.toUpperCase()})`}
                  onClick={() => setExpandedCat(id)}
                />
              );
            })}
          </div>

          <div className="mfg-live-cost-badge">
            <span className="cost-label">EST. UNIT COST</span>
            <strong className="cost-value">₹{formatINR(liveSummary?.unitCostInr ?? 21606)}</strong>
            <span className="lead-tag">~{liveSummary?.leadDays ?? 22}d</span>
          </div>
        </div>

        <div className="mfg-strip-actions">
          {!isAllConfirmed && nextIncompleteCatId && (
            <button
              className="mfg-action-link-btn"
              onClick={handleJumpToNext}
              title={`Jump to next step: ${CATEGORY_METADATA[nextIncompleteCatId]?.title}`}
            >
              <Icon>play_arrow</Icon> Continue (0{CATEGORY_METADATA[nextIncompleteCatId]?.num})
            </button>
          )}

          <button
            className="mfg-reset-link-btn"
            onClick={handleResetConfiguration}
            title="Reset configuration to beginning"
          >
            <Icon>refresh</Icon> Reset
          </button>
        </div>
      </div>

      {/* ─── Technical Dependency Alert Banner (when active) ────────────────── */}
      {allDependencies.length > 0 && (
        <div className="mfg-dep-banner" role="alert">
          <Icon className="dep-banner-icon">warning</Icon>
          <div className="dep-banner-content">
            <div className="dep-banner-title">
              <strong>{allDependencies.length} Engineering Conflict{allDependencies.length === 1 ? '' : 's'} Requiring Review:</strong>
            </div>
            <ul className="dep-banner-list">
              {allDependencies.map((dep, idx) => (
                <li key={idx} className="dep-banner-item">
                  <span className="dep-item-title">{dep.title}:</span> {dep.reason}
                  <button
                    className="dep-jump-btn"
                    onClick={() => setExpandedCat(dep.target)}
                    title={`Go to Step 0${CATEGORY_METADATA[dep.target]?.num} to review`}
                  >
                    Review 0{CATEGORY_METADATA[dep.target]?.num} →
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ─── Main Accordion Body ────────────────────────────────────────────── */}
      {!analysis ? (
        <div className="panel-empty-state-view">
          <Icon className="empty-state-icon">precision_manufacturing</Icon>
          <h3 className="empty-state-title">AWAITING COMPONENT MODEL</h3>
          <p className="empty-state-text">
            Reconstruct or load a component model from the central workspace to begin step-by-step manufacturing configuration.
          </p>
        </div>
      ) : (
        <div className="mfg-categories-accordion" role="region" aria-label="Sequential Manufacturing Configuration">
          {CATEGORY_ORDER.map((catId, index) => {
            const meta = CATEGORY_METADATA[catId];
            const isExpanded = expandedCat === catId;
            const status = statuses[catId]; // 'confirmed' | 'needs_review' | 'in_progress' | 'not_started'
            const isConfirmed = status === 'confirmed';
            const needsReview = status === 'needs_review';
            const catDeps = allDependencies.filter((d) => d.target === catId);

            return (
              <div
                key={catId}
                className={`mfg-cat-card ${isExpanded ? 'expanded' : ''} ${needsReview ? 'status-needs-review' : ''} ${isConfirmed ? 'status-confirmed' : ''}`}
              >
                {/* ─── Accordion Row Header ─── */}
                <button
                  type="button"
                  className="mfg-cat-header-btn"
                  onClick={() => setExpandedCat(isExpanded ? null : catId)}
                  aria-expanded={isExpanded}
                >
                  <div className="mfg-cat-icon-col">
                    <Icon>{meta.icon}</Icon>
                  </div>

                  <div className="mfg-cat-info-col">
                    <div className="mfg-cat-title-row">
                      <span className="mfg-cat-num">0{meta.num}</span>
                      <strong className="mfg-cat-title">{meta.title}</strong>

                      {/* Status Tag */}
                      {needsReview ? (
                        <span className="mfg-status-badge review" title="Requires review due to changed dependency">
                          <Icon>warning</Icon> NEEDS REVIEW
                        </span>
                      ) : isConfirmed ? (
                        <span className="mfg-status-badge confirmed" title="Selection explicitly confirmed">
                          <Icon>check_circle</Icon> CONFIRMED
                        </span>
                      ) : isExpanded ? (
                        <span className="mfg-status-badge in-progress">
                          IN PROGRESS
                        </span>
                      ) : (
                        <span className="mfg-status-badge not-started">
                          NOT STARTED
                        </span>
                      )}
                    </div>

                    <div className="mfg-cat-summary">
                      {getCategorySummary(catId)}
                    </div>
                  </div>

                  <div className="mfg-cat-status-col">
                    {/* The Green Checkmark displays exclusively for CONFIRMED */}
                    {isConfirmed && !needsReview && (
                      <span className="mfg-check-indicator" title="Category Confirmed">
                        <Icon>check_circle</Icon>
                      </span>
                    )}
                    {needsReview && (
                      <span className="mfg-review-indicator" title="Requires Engineering Review">
                        <Icon>error</Icon>
                      </span>
                    )}
                    <Icon className="mfg-chevron">{isExpanded ? 'expand_less' : 'expand_more'}</Icon>
                  </div>
                </button>

                {/* ─── Accordion Row Expanded Content ─── */}
                {isExpanded && (
                  <div className="mfg-cat-body">
                    {/* Category Guidance Description */}
                    <p className="mfg-opt-desc">{meta.description}</p>

                    {/* In-category Dependency Warning if flagged */}
                    {catDeps.length > 0 && (
                      <div className="mfg-cat-inline-warning">
                        <Icon>warning</Icon>
                        <div>
                          <strong>Engineering Advisory:</strong>
                          {catDeps.map((d, i) => (
                            <p key={i} className="inline-warn-text">{d.reason}</p>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ─── 01. GEOMETRY & DIMENSIONS ─── */}
                    {catId === CATEGORY_IDS.GEOMETRY && (
                      <div className="mfg-opt-content">
                        <div className="mfg-field-grid">
                          <div className="mfg-field">
                            <label htmlFor="field-od">Outer Diameter (OD, mm)</label>
                            <input
                              id="field-od"
                              type="number"
                              min="10"
                              max="3000"
                              step="0.5"
                              value={draftDecisions.outerDiameter ?? 100}
                              onChange={(e) => handleUpdateGeometryDraft('outerDiameter', parseFloat(e.target.value) || 0)}
                            />
                          </div>

                          <div className="mfg-field">
                            <label htmlFor="field-id">Inner Bore Diameter (ID, mm)</label>
                            <input
                              id="field-id"
                              type="number"
                              min="0"
                              max="2800"
                              step="0.5"
                              value={draftDecisions.innerDiameter ?? 25}
                              onChange={(e) => handleUpdateGeometryDraft('innerDiameter', parseFloat(e.target.value) || 0)}
                            />
                          </div>

                          <div className="mfg-field">
                            <label htmlFor="field-height">Face Width / Length (mm)</label>
                            <input
                              id="field-height"
                              type="number"
                              min="2"
                              max="1500"
                              step="0.5"
                              value={draftDecisions.height ?? 28}
                              onChange={(e) => handleUpdateGeometryDraft('height', parseFloat(e.target.value) || 0)}
                            />
                          </div>

                          <div className="mfg-field">
                            <label htmlFor="field-teeth">Tooth Count (z)</label>
                            <input
                              id="field-teeth"
                              type="number"
                              min="6"
                              max="500"
                              value={draftDecisions.teeth ?? 24}
                              onChange={(e) => handleUpdateGeometryDraft('teeth', parseInt(e.target.value, 10) || 0)}
                            />
                          </div>
                        </div>

                        {/* Parametric Geometry Engineering Insights */}
                        <EngineeringReasoningCard
                          catId={CATEGORY_IDS.GEOMETRY}
                          draftDecisions={draftDecisions}
                          quantity={draftQuantity}
                          analysis={analysis}
                        />

                        <div className="mfg-confirm-row">
                          <button
                            type="button"
                            className="mfg-confirm-btn"
                            disabled={
                              !draftDecisions.outerDiameter ||
                              !draftDecisions.innerDiameter ||
                              draftDecisions.innerDiameter >= draftDecisions.outerDiameter
                            }
                            onClick={() => handleConfirmCategory(CATEGORY_IDS.GEOMETRY)}
                          >
                            <Icon>check</Icon> Confirm Dimensions &amp; Next (02 Material)
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ─── 02. MATERIAL SELECTION ─── */}
                    {catId === CATEGORY_IDS.MATERIAL && (
                      <div className="mfg-opt-content">
                        <div className="mfg-choice-list" role="radiogroup" aria-label="Material Options">
                          {MATERIAL_OPTIONS.map((m) => {
                            const isSelected = draftDecisions.material?.id === m.id;
                            const isCurrentlyConfirmed = confirmedDecisions.material?.id === m.id && isConfirmed;

                            return (
                              <div
                                key={m.id}
                                className={`mfg-choice-card ${isSelected ? 'selected' : ''}`}
                                onClick={() => handleSelectOptionDraft(CATEGORY_IDS.MATERIAL, m)}
                                role="radio"
                                aria-checked={isSelected}
                              >
                                <div className="choice-head">
                                  <strong className="choice-title">{m.label}</strong>
                                  <span className="choice-cost-badge">{m.costBadge}</span>
                                </div>
                                <div className="choice-props">
                                  <span>Yield: {m.yieldMPa} MPa</span>
                                  <span>Hardness: {m.hardness}</span>
                                  {isCurrentlyConfirmed && <span className="confirmed-pill">Confirmed</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Engineering Reasoning & Comparative Trade-off Assessment */}
                        <EngineeringReasoningCard
                          catId={CATEGORY_IDS.MATERIAL}
                          selectedOption={draftDecisions.material}
                          draftDecisions={draftDecisions}
                          quantity={draftQuantity}
                          analysis={analysis}
                        />

                        <div className="mfg-confirm-row">
                          <button
                            type="button"
                            className="mfg-confirm-btn"
                            disabled={!draftDecisions.material}
                            onClick={() => handleConfirmCategory(CATEGORY_IDS.MATERIAL)}
                          >
                            <Icon>check</Icon> Confirm Material &amp; Next (03 Process)
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ─── 03. MANUFACTURING PROCESS ─── */}
                    {catId === CATEGORY_IDS.PROCESS && (
                      <div className="mfg-opt-content">
                        <div className="mfg-choice-list" role="radiogroup" aria-label="Manufacturing Process Routes">
                          {PROCESS_OPTIONS.map((p) => {
                            const isSelected = draftDecisions.process?.id === p.id;
                            const isCurrentlyConfirmed = confirmedDecisions.process?.id === p.id && isConfirmed;

                            return (
                              <div
                                key={p.id}
                                className={`mfg-choice-card ${isSelected ? 'selected' : ''}`}
                                onClick={() => handleSelectOptionDraft(CATEGORY_IDS.PROCESS, p)}
                                role="radio"
                                aria-checked={isSelected}
                              >
                                <div className="choice-head">
                                  <div className="choice-title-group">
                                    <strong className="choice-title">{p.label}</strong>
                                    <span className="choice-spec-badge">{p.accuracy}</span>
                                  </div>
                                  <span className="choice-cost-badge">{p.costBadge}</span>
                                </div>
                                <div className="choice-props">
                                  <span>Lead Time: {p.leadTime}</span>
                                  {isCurrentlyConfirmed && <span className="confirmed-pill">Confirmed</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Engineering Reasoning & Comparative Trade-off Assessment */}
                        <EngineeringReasoningCard
                          catId={CATEGORY_IDS.PROCESS}
                          selectedOption={draftDecisions.process}
                          draftDecisions={draftDecisions}
                          quantity={draftQuantity}
                          analysis={analysis}
                        />

                        <div className="mfg-confirm-row">
                          <button
                            type="button"
                            className="mfg-confirm-btn"
                            disabled={!draftDecisions.process}
                            onClick={() => handleConfirmCategory(CATEGORY_IDS.PROCESS)}
                          >
                            <Icon>check</Icon> Confirm Process &amp; Next (04 Surface)
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ─── 04. SURFACE TREATMENT ─── */}
                    {catId === CATEGORY_IDS.SURFACE && (
                      <div className="mfg-opt-content">
                        <div className="mfg-choice-list" role="radiogroup" aria-label="Surface Treatment Options">
                          {SURFACE_OPTIONS.map((s) => {
                            const isSelected = draftDecisions.surfaceTreatment?.id === s.id;
                            const isCurrentlyConfirmed = confirmedDecisions.surfaceTreatment?.id === s.id && isConfirmed;

                            return (
                              <div
                                key={s.id}
                                className={`mfg-choice-card ${isSelected ? 'selected' : ''}`}
                                onClick={() => handleSelectOptionDraft(CATEGORY_IDS.SURFACE, s)}
                                role="radio"
                                aria-checked={isSelected}
                              >
                                <div className="choice-head">
                                  <div className="choice-title-group">
                                    <strong className="choice-title">{s.label}</strong>
                                    <span className="choice-spec-badge">{s.dimensionalBuildup}</span>
                                  </div>
                                  <span className="choice-cost-badge">{s.costBadge}</span>
                                </div>
                                <div className="choice-props">
                                  <span>Buildup: {s.dimensionalBuildup}</span>
                                  {isCurrentlyConfirmed && <span className="confirmed-pill">Confirmed</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Engineering Reasoning & Comparative Trade-off Assessment */}
                        <EngineeringReasoningCard
                          catId={CATEGORY_IDS.SURFACE}
                          selectedOption={draftDecisions.surfaceTreatment}
                          draftDecisions={draftDecisions}
                          quantity={draftQuantity}
                          analysis={analysis}
                        />

                        <div className="mfg-confirm-row">
                          <button
                            type="button"
                            className="mfg-confirm-btn"
                            disabled={!draftDecisions.surfaceTreatment}
                            onClick={() => handleConfirmCategory(CATEGORY_IDS.SURFACE)}
                          >
                            <Icon>check</Icon> Confirm Surface &amp; Next (05 Tolerances)
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ─── 05. TOLERANCES & FITS ─── */}
                    {catId === CATEGORY_IDS.TOLERANCES && (
                      <div className="mfg-opt-content">
                        <div className="mfg-choice-list" role="radiogroup" aria-label="Tolerances & Accuracy Classes">
                          {TOLERANCE_OPTIONS.map((t) => {
                            const isSelected = draftDecisions.tolerances?.id === t.id;
                            const isCurrentlyConfirmed = confirmedDecisions.tolerances?.id === t.id && isConfirmed;

                            return (
                              <div
                                key={t.id}
                                className={`mfg-choice-card ${isSelected ? 'selected' : ''}`}
                                onClick={() => handleSelectOptionDraft(CATEGORY_IDS.TOLERANCES, t)}
                                role="radio"
                                aria-checked={isSelected}
                              >
                                <div className="choice-head">
                                  <div className="choice-title-group">
                                    <strong className="choice-title">{t.label}</strong>
                                    <span className="choice-spec-badge">Pitch error: {t.pitchError}</span>
                                  </div>
                                  <span className="choice-cost-badge">{t.costBadge}</span>
                                </div>
                                <div className="choice-props">
                                  <span>Backlash: {t.backlash}</span>
                                  {isCurrentlyConfirmed && <span className="confirmed-pill">Confirmed</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Engineering Reasoning & Comparative Trade-off Assessment */}
                        <EngineeringReasoningCard
                          catId={CATEGORY_IDS.TOLERANCES}
                          selectedOption={draftDecisions.tolerances}
                          draftDecisions={draftDecisions}
                          quantity={draftQuantity}
                          analysis={analysis}
                        />

                        <div className="mfg-confirm-row">
                          <button
                            type="button"
                            className="mfg-confirm-btn"
                            disabled={!draftDecisions.tolerances}
                            onClick={() => handleConfirmCategory(CATEGORY_IDS.TOLERANCES)}
                          >
                            <Icon>check</Icon> Confirm Tolerances &amp; Next (06 Heat Treat)
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ─── 06. HEAT TREATMENT ─── */}
                    {catId === CATEGORY_IDS.HEAT_TREATMENT && (
                      <div className="mfg-opt-content">
                        <div className="mfg-choice-list" role="radiogroup" aria-label="Heat Treatment Options">
                          {HEAT_TREATMENT_OPTIONS.map((h) => {
                            const isSelected = draftDecisions.heatTreatment?.id === h.id;
                            const isCurrentlyConfirmed = confirmedDecisions.heatTreatment?.id === h.id && isConfirmed;

                            return (
                              <div
                                key={h.id}
                                className={`mfg-choice-card ${isSelected ? 'selected' : ''}`}
                                onClick={() => handleSelectOptionDraft(CATEGORY_IDS.HEAT_TREATMENT, h)}
                                role="radio"
                                aria-checked={isSelected}
                              >
                                <div className="choice-head">
                                  <div className="choice-title-group">
                                    <strong className="choice-title">{h.label}</strong>
                                    <span className="choice-spec-badge">{h.hardness}</span>
                                  </div>
                                  <span className="choice-cost-badge">{h.costBadge}</span>
                                </div>
                                <div className="choice-props">
                                  <span>Hardness: {h.hardness}</span>
                                  {isCurrentlyConfirmed && <span className="confirmed-pill">Confirmed</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Engineering Reasoning & Comparative Trade-off Assessment */}
                        <EngineeringReasoningCard
                          catId={CATEGORY_IDS.HEAT_TREATMENT}
                          selectedOption={draftDecisions.heatTreatment}
                          draftDecisions={draftDecisions}
                          quantity={draftQuantity}
                          analysis={analysis}
                        />

                        <div className="mfg-confirm-row">
                          <button
                            type="button"
                            className="mfg-confirm-btn"
                            disabled={!draftDecisions.heatTreatment}
                            onClick={() => handleConfirmCategory(CATEGORY_IDS.HEAT_TREATMENT)}
                          >
                            <Icon>check</Icon> Confirm Heat Treatment &amp; Next (07 Quality)
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ─── 07. QUALITY INSPECTION ─── */}
                    {catId === CATEGORY_IDS.INSPECTION && (
                      <div className="mfg-opt-content">
                        <div className="mfg-choice-list" role="radiogroup" aria-label="Inspection Protocols">
                          {INSPECTION_OPTIONS.map((i) => {
                            const isSelected = draftDecisions.inspection?.id === i.id;
                            const isCurrentlyConfirmed = confirmedDecisions.inspection?.id === i.id && isConfirmed;

                            return (
                              <div
                                key={i.id}
                                className={`mfg-choice-card ${isSelected ? 'selected' : ''}`}
                                onClick={() => handleSelectOptionDraft(CATEGORY_IDS.INSPECTION, i)}
                                role="radio"
                                aria-checked={isSelected}
                              >
                                <div className="choice-head">
                                  <strong className="choice-title">{i.label}</strong>
                                  <span className="choice-cost-badge">{i.costBadge}</span>
                                </div>
                                <div className="choice-props">
                                  <span>Protocol: {i.isCmm ? 'EN 10204 3.1 Traceable' : 'Standard Metrology'}</span>
                                  {isCurrentlyConfirmed && <span className="confirmed-pill">Confirmed</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Engineering Reasoning & Comparative Trade-off Assessment */}
                        <EngineeringReasoningCard
                          catId={CATEGORY_IDS.INSPECTION}
                          selectedOption={draftDecisions.inspection}
                          draftDecisions={draftDecisions}
                          quantity={draftQuantity}
                          analysis={analysis}
                        />

                        <div className="mfg-confirm-row">
                          <button
                            type="button"
                            className="mfg-confirm-btn"
                            disabled={!draftDecisions.inspection}
                            onClick={() => handleConfirmCategory(CATEGORY_IDS.INSPECTION)}
                          >
                            <Icon>check</Icon> Confirm Inspection &amp; Next (08 Quantity)
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ─── 08. BATCH QUANTITY ─── */}
                    {catId === CATEGORY_IDS.QUANTITY && (
                      <div className="mfg-opt-content">
                        <div className="mfg-qty-controller">
                          <label htmlFor="mfg-batch-qty">Production Batch Size (Units)</label>
                          <div className="qty-stepper-row">
                            <button
                              type="button"
                              className="qty-btn"
                              onClick={() => handleSelectQuantityDraft(Math.max(1, draftQuantity - 1))}
                              disabled={draftQuantity <= 1}
                            >
                              -
                            </button>
                            <input
                              id="mfg-batch-qty"
                              type="number"
                              min="1"
                              max="100000"
                              value={draftQuantity}
                              onChange={(e) => handleSelectQuantityDraft(Math.max(1, Math.min(100000, parseInt(e.target.value, 10) || 1)))}
                            />
                            <button
                              type="button"
                              className="qty-btn"
                              onClick={() => handleSelectQuantityDraft(Math.min(100000, draftQuantity + 1))}
                            >
                              +
                            </button>
                          </div>
                        </div>

                        <div className="mfg-qty-tier-pills">
                          {QUANTITY_TIERS.map((tier) => (
                            <button
                              type="button"
                              key={tier}
                              className={`tier-pill ${draftQuantity === tier ? 'active' : ''}`}
                              onClick={() => handleSelectQuantityDraft(tier)}
                            >
                              {tier} {tier === 1 ? 'unit' : 'units'}
                            </button>
                          ))}
                        </div>

                        {/* Scale Economy & Tooling Amortization Reasoning */}
                        <EngineeringReasoningCard
                          catId={CATEGORY_IDS.QUANTITY}
                          draftDecisions={draftDecisions}
                          quantity={draftQuantity}
                          analysis={analysis}
                        />

                        <div className="mfg-confirm-row">
                          <button
                            type="button"
                            className="mfg-confirm-btn"
                            disabled={draftQuantity < 1}
                            onClick={() => handleConfirmCategory(CATEGORY_IDS.QUANTITY)}
                          >
                            <Icon>check</Icon> Confirm Batch Quantity &amp; Next (09 Packaging)
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ─── 09. PACKAGING & DELIVERY ─── */}
                    {catId === CATEGORY_IDS.PACKAGING && (
                      <div className="mfg-opt-content">
                        <div className="mfg-choice-list" role="radiogroup" aria-label="Packaging Protocols">
                          {PACKAGING_OPTIONS.map((pk) => {
                            const isSelected = draftDecisions.packaging?.id === pk.id;
                            const isCurrentlyConfirmed = confirmedDecisions.packaging?.id === pk.id && isConfirmed;

                            return (
                              <div
                                key={pk.id}
                                className={`mfg-choice-card ${isSelected ? 'selected' : ''}`}
                                onClick={() => handleSelectOptionDraft(CATEGORY_IDS.PACKAGING, pk)}
                                role="radio"
                                aria-checked={isSelected}
                              >
                                <div className="choice-head">
                                  <strong className="choice-title">{pk.label}</strong>
                                  <span className="choice-cost-badge">{pk.costBadge}</span>
                                </div>
                                <div className="choice-props">
                                  <span>Protection: {pk.isVci ? 'Active VCI Vapor (24 Mo)' : pk.isHeavyDuty ? 'Shock Isolated Crate' : 'Corrugated Partition'}</span>
                                  {isCurrentlyConfirmed && <span className="confirmed-pill">Confirmed</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Engineering Reasoning & Comparative Trade-off Assessment */}
                        <EngineeringReasoningCard
                          catId={CATEGORY_IDS.PACKAGING}
                          selectedOption={draftDecisions.packaging}
                          draftDecisions={draftDecisions}
                          quantity={draftQuantity}
                          analysis={analysis}
                        />

                        <div className="mfg-confirm-row">
                          <button
                            type="button"
                            className="mfg-confirm-btn"
                            disabled={!draftDecisions.packaging}
                            onClick={() => handleConfirmCategory(CATEGORY_IDS.PACKAGING)}
                          >
                            <Icon>check</Icon> Confirm Packaging &amp; Finalize Specification
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* ─── 07. Final Completed Specification Summary Card ──────────────── */}
          {isAllConfirmed && (
            <div className="mfg-completed-summary-card">
              <div className="completed-summary-head">
                <Icon className="completed-badge-icon">verified</Icon>
                <div>
                  <h3 className="completed-summary-title">SPECIFICATION COMPLETE &amp; VERIFIED</h3>
                  <span className="completed-summary-sub">All 9 Manufacturing Categories Confirmed · No Conflicts</span>
                </div>
              </div>

              <div className="completed-cost-grid">
                <div className="completed-cost-cell">
                  <span className="cost-cell-label">TOTAL BATCH PRICE</span>
                  <strong className="cost-cell-val">₹{formatINR(liveSummary?.totalBatchCostInr ?? (21606 * (propQuantity || 1)))}</strong>
                  <span className="cost-cell-sub">for {propQuantity} unit{propQuantity === 1 ? '' : 's'}</span>
                </div>
                <div className="completed-cost-cell">
                  <span className="cost-cell-label">PER-UNIT PRICE</span>
                  <strong className="cost-cell-val">₹{formatINR(liveSummary?.unitCostInr ?? 21606)}</strong>
                  <span className="cost-cell-sub">ex-works</span>
                </div>
                <div className="completed-cost-cell">
                  <span className="cost-cell-label">EST. LEAD TIME</span>
                  <strong className="cost-cell-val">~{liveSummary?.leadDays ?? 22} days</strong>
                  <span className="cost-cell-sub">dispatch ready</span>
                </div>
              </div>

              {onOpenReport && (
                <div className="completed-report-action">
                  <button
                    type="button"
                    className="mfg-report-open-btn"
                    onClick={onOpenReport}
                  >
                    <Icon>description</Icon> Open Engineering Report Preview
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Draggable Resize Slider on Left Edge */}
      {!isMaximized && !isFloatingContent && (
        <div
          className="panel-resizer-handle horizontal left"
          onMouseDown={handleMouseDownResizer}
          title="Drag to resize Manufacturing Decisions panel"
          aria-label="Resize Manufacturing Decisions Panel"
        />
      )}
    </aside>
  );
}

export default ManufacturingDecisionPanel;
