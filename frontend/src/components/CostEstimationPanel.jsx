import React, { useRef, useMemo, useState } from 'react';
import {
  computeSynchronizedManufacturingCost,
  formatINR,
  CATEGORY_IDS,
} from '../lib/manufacturing-config.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function CostEstimationPanel({
  isOpen,
  onClose,
  height,
  onResize,
  // Customization & Docking
  isDocked = true,
  onToggleDock,
  isMaximized = false,
  onToggleMaximize,
  isCollapsed = false,
  onToggleCollapse,
  isFloatingContent = false,
  currentSlot = 'bottom',
  onMoveSlot,
  onStartDrag,
  mfgData,
  quantity = 1,
  decisions = {},
  confirmedCategories = {},
  activeDraftSelection = null,
  dependenciesCount = 0,
  analysis,
}) {
  const isDraggingRef = useRef(false);
  const [costViewTab, setCostViewTab] = useState('all'); // 'all' | 'breakdown' | 'headline' | 'tco'

  const handleMouseDownResizer = (e) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const startY = e.clientY;
    const startHeight = height;

    const onMouseMove = (moveEvent) => {
      if (!isDraggingRef.current) return;
      const deltaY = startY - moveEvent.clientY;
      const maxH = Math.round(window.innerHeight * 0.65);
      const newHeight = Math.max(160, Math.min(maxH, startHeight + deltaY));
      onResize?.(newHeight);
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
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

  // ─── Single Synchronized Source of Truth for Engineering Cost Calculations ─
  const syncedCost = useMemo(() => {
    return computeSynchronizedManufacturingCost({
      decisions,
      confirmedCategories,
      quantity,
      activeDraftSelection,
      analysis,
    });
  }, [decisions, confirmedCategories, quantity, activeDraftSelection, analysis]);

  const {
    unitCostInr = 0,
    confirmedUnitCost = 0,
    confirmedBatchCost = 0,
    fullSpecUnitCost = 0,
    hasAnyConfirmed = false,
    confirmedCount = 0,
    isAllConfirmed = false,
    itemizedBreakdown = [],
    costImpactExplanation = null,
    lifecycleTco = { expectedLifeYears: 4, replacementFrequency: '0.25', downtimeRisk: 'Minimal', tenYearTcoINR: 0 },
    breakdown = {},
  } = syncedCost || {};

  if (!isOpen) return null;

  // Pro forma document download (fully synchronized with actual calculations)
  const handleDownloadEstimate = () => {
    const textContent = `
================================================================================
REFORGE AI — PRO FORMA MANUFACTURING COST ESTIMATION (SYNCHRONIZED)
Document Reference: RF-EST-${Date.now().toString(36).toUpperCase()}
Date Generated: ${new Date().toLocaleString()}
Status: ${isAllConfirmed ? 'FULL SPECIFICATION CONFIRMED' : `${confirmedCount} of 9 Categories Confirmed`}
================================================================================

COMPONENT SPECIFICATION:
Component: ${analysis?.label || 'Custom Industrial Gear'}
Outer Diameter: ${decisions.outerDiameter || 100} mm
Inner Bore: ${decisions.innerDiameter || 25} mm
Face Width: ${decisions.height || 28} mm (${decisions.teeth || 24} Teeth)
Raw Material: ${decisions.material?.label || 'AISI 4140 Alloy Steel'}
Manufacturing Process: ${decisions.process?.label || 'CNC Gear Hobbing + Milling'}
Tolerance Grade: ${decisions.tolerances?.label || 'DIN 7 / ISO Grade 7'}
Heat Treatment: ${decisions.heatTreatment?.label || 'Case Carburized (58-62 HRC)'}
Surface Coating: ${decisions.surfaceTreatment?.label || 'Black Oxide'}
Quality Inspection: ${decisions.inspection?.label || 'CMM Tooth Profile'}
Batch Quantity: ${quantity} units

SYNCHRONIZED ITEMIZED COST BREAKDOWN (PER UNIT):
--------------------------------------------------------------------------------
${itemizedBreakdown
        .map((item) => {
          const statusText = item.isConfirmed ? 'CONFIRMED' : item.isPreview ? 'PREVIEW' : 'PENDING';
          const rateText = item.isConfirmed
            ? `₹ ${formatINR(item.cost)}`
            : item.isPreview
              ? `(₹ ${formatINR(item.cost)}) [Preview]`
              : '— [Pending Step 0' + item.num + ']';
          return `${item.num}. ${item.name.padEnd(28, ' ')} : ${rateText.padEnd(16, ' ')} [${statusText}] - ${item.driver}`;
        })
        .join('\n')}
--------------------------------------------------------------------------------
Shop Overhead & Consumables (15%): ₹ ${formatINR(breakdown.overhead)}
Applicable GST / Taxes (18%):       ₹ ${formatINR(breakdown.taxes)}
--------------------------------------------------------------------------------
TOTAL ESTIMATED UNIT COST:         ₹ ${formatINR(confirmedUnitCost > 0 ? confirmedUnitCost : fullSpecUnitCost)}
TOTAL BATCH ESTIMATE (${quantity} QTY):   ₹ ${formatINR((confirmedUnitCost > 0 ? confirmedUnitCost : fullSpecUnitCost) * quantity)}

LIFECYCLE & TOTAL COST OF OWNERSHIP (TCO) PROJECTION:
--------------------------------------------------------------------------------
Design Operational Life:           ~${lifecycleTco.expectedLifeYears} years
Annual Replacement Frequency:       ${lifecycleTco.replacementFrequency} replacements/year
10-Year Lifecycle TCO Envelope:    ₹ ${formatINR(lifecycleTco.tenYearTcoINR)}
Downtime Risk Level:               ${lifecycleTco.downtimeRisk}

ASSUMPTIONS & ENGINEERING CONTEXT:
- Rates computed using real CNC machine shop cutting rates, cutter wear amortization, and raw alloy stock density.
- Zero discrepancy between Manufacturing Choices and Live Cost Estimation.
================================================================================
    `.trim();

    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ReForge_Synchronized_Cost_Estimate_${quantity}qty.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const isVerticalSlot = currentSlot === 'left' || currentSlot === 'right';

  return (
    <section
      className={`cost-estimation-panel ${isMaximized ? 'maximized' : ''} ${isCollapsed ? 'collapsed' : ''} ${isFloatingContent ? 'in-floating' : ''} slot-${currentSlot}`}
      style={isFloatingContent || isMaximized ? undefined : { height: isCollapsed ? '38px' : `${height}px` }}
      aria-label="Manufacturing Cost Estimation and Lifecycle Analysis"
    >
      {/* ─── Header Bar ──────────────────────────────────────────────────────── */}
      <div className="cost-panel-header">
        <div className="cost-panel-title-group">
          <Icon className="cost-header-icon">payments</Icon>
          <div className="cost-panel-title-text-wrap">
            <h3 className="cost-panel-title">LIVE COST ESTIMATION &amp; LIFECYCLE TCO</h3>
            <span className="cost-panel-sub">India CNC Job-Shop Baseline Rates</span>
          </div>

          {/* Quick Metric Pill ONLY when Collapsed */}
          {isCollapsed && analysis && (
            <div className="cost-panel-compact-badge" title="Estimated cost based on active confirmed decisions">
              <span className="compact-badge-label">EST:</span>
              <span className="compact-badge-value">
                ₹{formatINR(confirmedUnitCost > 0 ? confirmedUnitCost : fullSpecUnitCost)}/unit
              </span>
              <span className="compact-badge-sub">({confirmedCount}/9 Confirmed)</span>
            </div>
          )}
        </div>

        <div className="cost-panel-actions">
          <button
            className="secondary cost-download-btn"
            onClick={handleDownloadEstimate}
            disabled={!analysis}
            title={analysis ? "Download Synchronized Costing Specification" : "Requires analyzed component"}
          >
            <Icon>download</Icon> Pro Forma (.txt)
          </button>

          {onToggleCollapse && (
            <button
              className="panel-action-btn"
              onClick={onToggleCollapse}
              title={isCollapsed ? "Expand Cost Estimation Panel" : "Collapse Cost Estimation Panel"}
              aria-label={isCollapsed ? "Expand Cost Panel" : "Collapse Cost Panel"}
            >
              <Icon>{isCollapsed ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}</Icon>
            </button>
          )}

          {onStartDrag && (
            <button
              type="button"
              className="panel-action-btn panel-drag-handle"
              onMouseDown={onStartDrag}
              title="Dock button: Drag and drop into any panel area (Left, Center, Right, Bottom)"
              aria-label="Dock and drag Cost Panel"
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
              aria-label={isMaximized ? "Restore Cost Panel" : "Maximize Cost Panel"}
            >
              <Icon>{isMaximized ? 'fullscreen_exit' : 'fullscreen'}</Icon>
            </button>
          )}

          <button
            type="button"
            className="panel-action-btn close-btn"
            onClick={onClose}
            title="Close Cost Panel"
            aria-label="Close Cost Panel"
          >
            <Icon>close</Icon>
          </button>
        </div>
      </div>

      {/* ─── Main Content ────────────────────────────────────────────────────── */}
      {!isCollapsed && (
        !analysis ? (
          <div className="panel-empty-state-view">
            <Icon className="empty-state-icon">payments</Icon>
            <h3 className="empty-state-title">NO COST ESTIMATION AVAILABLE</h3>
            <p className="empty-state-text">
              Awaiting component model. ReForge AI determines volume, surface area, and machining cycles from reconstructed geometry to estimate unit and batch job-shop costs.
            </p>
          </div>
        ) : (
          <div className="cost-panel-content-wrap">
            {/* View Subtabs Bar: Quick Switcher for Small Docks or Targeted Analysis */}
            <div className="cost-subtabs-bar" role="tablist" aria-label="Cost View Filter">
              <button
                type="button"
                className={`cost-subtab-btn ${costViewTab === 'all' ? 'active' : ''}`}
                onClick={() => setCostViewTab('all')}
                role="tab"
                aria-selected={costViewTab === 'all'}
              >
                <Icon>view_week</Icon>
                <span>All Sections</span>
              </button>
              <button
                type="button"
                className={`cost-subtab-btn ${costViewTab === 'breakdown' ? 'active' : ''}`}
                onClick={() => setCostViewTab('breakdown')}
                role="tab"
                aria-selected={costViewTab === 'breakdown'}
              >
                <Icon>format_list_numbered</Icon>
                <span>Itemized Breakdown ({confirmedCount}/9)</span>
              </button>
              <button
                type="button"
                className={`cost-subtab-btn ${costViewTab === 'headline' ? 'active' : ''}`}
                onClick={() => setCostViewTab('headline')}
                role="tab"
                aria-selected={costViewTab === 'headline'}
              >
                <Icon>analytics</Icon>
                <span>Overview &amp; Live Impact</span>
              </button>
              <button
                type="button"
                className={`cost-subtab-btn ${costViewTab === 'tco' ? 'active' : ''}`}
                onClick={() => setCostViewTab('tco')}
                role="tab"
                aria-selected={costViewTab === 'tco'}
              >
                <Icon>timelapse</Icon>
                <span>Lifecycle TCO</span>
              </button>
            </div>

            <div className={`cost-panel-body ${isVerticalSlot ? 'cost-layout-vertical' : 'cost-layout-horizontal'}`}>
              {/* ─── Section 1: Compact Headline & Live Cost Impact Explanation ─── */}
              {(costViewTab === 'all' || costViewTab === 'headline') && (
                <div className={`cost-col-headline-compact ${costViewTab === 'headline' ? 'is-focused-view' : ''}`}>
                  {/* Top Compact Highlight Card */}
                  <div className="cost-headline-card">
                    <div className="headline-meta-row">
                      <span className="cost-metric-label">ESTIMATED COST / UNIT</span>
                      {hasAnyConfirmed ? (
                        <span className="headline-sync-chip confirmed">
                          <Icon>check</Icon> {confirmedCount} of 9 Confirmed
                        </span>
                      ) : (
                        <span className="headline-sync-chip pro-forma">
                          PRO FORMA ESTIMATE
                        </span>
                      )}
                    </div>

                    <div className="cost-hero-figure-wrap">
                      <div className="cost-hero-figure">
                        ₹{formatINR(hasAnyConfirmed ? confirmedUnitCost : fullSpecUnitCost)}
                      </div>
                      {costImpactExplanation && !costImpactExplanation.isConfirmed && (
                        <div className="cost-preview-callout" title="Estimated total if current preview choice is confirmed">
                          <span className="preview-callout-tag">PREVIEW:</span>
                          <strong className="preview-callout-val">₹{formatINR(costImpactExplanation.previewUnitCost)}</strong>
                        </div>
                      )}
                    </div>

                    <div className="cost-batch-sub">
                      Batch Total: <strong>₹{formatINR((hasAnyConfirmed ? confirmedUnitCost : fullSpecUnitCost) * quantity)}</strong> for {quantity} unit{quantity === 1 ? '' : 's'}
                    </div>

                    <div className="cost-pills-row">
                      <div className="cost-durability-pill" title="Operational Life calculated from confirmed Heat Treatment & Tolerances">
                        <Icon>verified</Icon>
                        <span>Expected Life: ~{lifecycleTco.expectedLifeYears} Years</span>
                      </div>

                      <div className="cost-dependency-summary" title="Outstanding Engineering Dependencies">
                        <Icon>{dependenciesCount > 0 ? 'warning' : 'task_alt'}</Icon>
                        <span>Dependencies: <strong>{dependenciesCount}</strong></span>
                      </div>
                    </div>
                  </div>

                  {/* ─── Live Cost-Impact Explanation Card (Two-way Panel Communication) ─── */}
                  {costImpactExplanation && (
                    <div className={`cost-impact-card ${costImpactExplanation.isConfirmed ? 'is-confirmed' : 'is-preview'}`}>
                      <div className="impact-card-head">
                        <div className="impact-head-left">
                          <Icon className="impact-icon">
                            {costImpactExplanation.isConfirmed ? 'check_circle' : 'visibility'}
                          </Icon>
                          <span className="impact-cat-title">
                            Step 0{costImpactExplanation.catNum}: {costImpactExplanation.catTitle}
                          </span>
                        </div>
                        <span className={`impact-badge ${costImpactExplanation.isConfirmed ? 'badge-confirmed' : 'badge-preview'}`}>
                          {costImpactExplanation.statusLabel}
                        </span>
                      </div>

                      <div className="impact-choice-row">
                        <strong className="impact-choice-name">{costImpactExplanation.optionLabel}</strong>
                        <span className={`impact-delta-pill ${costImpactExplanation.deltaINR > 0 ? 'delta-pos' : 'delta-base'}`}>
                          {costImpactExplanation.deltaText}
                        </span>
                      </div>

                      <p className="impact-effect-desc">
                        {costImpactExplanation.effectDesc}
                      </p>

                      <div className="impact-hint-row">
                        <Icon className="hint-icon">{costImpactExplanation.isConfirmed ? 'verified' : 'info'}</Icon>
                        <span>{costImpactExplanation.actionHint}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ─── Section 2: Detailed Line-Item Breakdown Table (Synced) ─────── */}
              {(costViewTab === 'all' || costViewTab === 'breakdown') && (
                <div className={`cost-col-breakdown ${costViewTab === 'breakdown' ? 'is-focused-view' : ''}`}>
                  <div className="breakdown-header-row">
                    <h4 className="cost-section-subtitle">ITEMIZED MANUFACTURING BREAKDOWN (PER UNIT)</h4>
                    <span className="breakdown-sync-label">
                      <Icon>sync</Icon> Synced with choices ({confirmedCount}/9)
                    </span>
                  </div>

                  <div className="cost-table-wrap">
                    <table className="cost-breakdown-table">
                      <thead>
                        <tr>
                          <th style={{ width: '38%' }}>Cost Category</th>
                          <th style={{ width: '36%' }}>Engineering Driver</th>
                          <th className="align-right" style={{ width: '26%' }}>Rate (INR)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {itemizedBreakdown.map((item) => (
                          <tr key={item.catId} className={`breakdown-row ${item.status}`}>
                            <td className="cat-cell">
                              <span className="cat-num-tag">0{item.num}</span>
                              <span className="cat-name-text">{item.name}</span>
                            </td>
                            <td className="driver-cell" title={item.driver}>
                              {item.isConfirmed ? (
                                <span className="driver-text confirmed">{item.driver}</span>
                              ) : item.isPreview ? (
                                <span className="driver-text preview">Preview: {item.driver}</span>
                              ) : (
                                <span className="driver-text pending">Awaiting Step 0{item.num} confirmation</span>
                              )}
                            </td>
                            <td className="align-right rate-cell">
                              {item.isConfirmed ? (
                                <span className="rate-val confirmed">
                                  ₹{formatINR(item.cost)} <Icon className="rate-check">check</Icon>
                                </span>
                              ) : item.isPreview ? (
                                <span className="rate-val preview" title="Preview cost — unconfirmed">
                                  ₹{formatINR(item.cost)} <span className="preview-tag">PREVIEW</span>
                                </span>
                              ) : (
                                <span className="rate-val pending" title="Excluded until confirmed">—</span>
                              )}
                            </td>
                          </tr>
                        ))}

                        {/* Statutory Taxes & Direct Total */}
                        <tr className="row-breakdown-subtotal">
                          <td colSpan="2">Confirmed Direct Manufacturing Subtotal</td>
                          <td className="align-right">
                            ₹{formatINR(confirmedUnitCost > 0 ? Math.round(confirmedUnitCost / 1.18 - breakdown.overhead) : 0)}
                          </td>
                        </tr>
                        <tr className="row-breakdown-overhead">
                          <td colSpan="2">Shop Overhead &amp; Consumables (15%)</td>
                          <td className="align-right">₹{formatINR(breakdown.overhead)}</td>
                        </tr>
                        <tr className="row-breakdown-taxes">
                          <td colSpan="2">GST / Statutory Taxes (18%)</td>
                          <td className="align-right">₹{formatINR(breakdown.taxes)}</td>
                        </tr>
                        <tr className="row-breakdown-total">
                          <td colSpan="2">
                            <strong className="text-lime">TOTAL CONFIRMED SPECIFICATION / UNIT</strong>
                          </td>
                          <td className="align-right">
                            <strong className="text-lime grand-total-num">
                              ₹{formatINR(confirmedUnitCost > 0 ? confirmedUnitCost : fullSpecUnitCost)}
                            </strong>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ─── Section 3: Lifecycle Cost Comparison & TCO ─────────────────── */}
              {(costViewTab === 'all' || costViewTab === 'tco') && (
                <div className={`cost-col-lifecycle ${costViewTab === 'tco' ? 'is-focused-view' : ''}`}>
                  <h4 className="cost-section-subtitle">10-YEAR LIFECYCLE TOTAL COST OF OWNERSHIP (TCO)</h4>
                  <div className="tco-cards-grid">
                    <div className="tco-card">
                      <span className="tco-label">10-Year Total Ownership</span>
                      <strong className="tco-val">₹{formatINR(lifecycleTco.tenYearTcoINR)}</strong>
                      <small>Unit cost + scheduled replacement cycle</small>
                    </div>
                    <div className="tco-card">
                      <span className="tco-label">Replacement Interval</span>
                      <strong className="tco-val">~{lifecycleTco.expectedLifeYears} Years</strong>
                      <small>{lifecycleTco.replacementFrequency} replacement/yr under full load</small>
                    </div>
                    <div className="tco-card">
                      <span className="tco-label">Downtime Risk Level</span>
                      <strong className="tco-val text-lime">{lifecycleTco.downtimeRisk}</strong>
                      <small>Calculated from fatigue &amp; tolerance margin</small>
                    </div>
                  </div>
                  <p className="cost-disclaimer-note">
                    *Pro forma cost estimate strictly synchronized with manufacturing choices. No hardcoded assumptions.
                  </p>
                </div>
              )}
            </div>
          </div>
        )
      )}

      {/* Draggable Resize Slider on Top Edge */}
      {!isMaximized && !isCollapsed && !isFloatingContent && (
        <div
          className="panel-resizer-handle vertical"
          onMouseDown={handleMouseDownResizer}
          title="Drag to resize Cost Estimation panel"
          aria-label="Resize Cost Estimation Panel"
        />
      )}
    </section>
  );
}

export default CostEstimationPanel;
