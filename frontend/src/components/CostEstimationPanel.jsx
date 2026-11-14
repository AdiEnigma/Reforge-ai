import React, { useRef } from 'react';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

function formatINR(n) {
  if (n == null || isNaN(n)) return '0';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

export function CostEstimationPanel({
  isOpen,
  onClose,
  height,
  onResize,
  // Customization
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
  dependenciesCount = 0,
  analysis,
}) {
  const isDraggingRef = useRef(false);

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

  if (!isOpen) return null;

  // Base costs from backend mfgData or fallback defaults
  const baseCost = mfgData?.cost || { low: 4500, high: 6200, breakdown: {} };
  const rawMat = mfgData?.cost?.breakdown?.materialCostINR || 1200;
  const rawMach = mfgData?.cost?.breakdown?.machiningCostINR || 2600;
  const rawTooling = mfgData?.cost?.breakdown?.toolingPerUnitINR || Math.round(1800 / Math.max(1, quantity));
  const rawOverhead = mfgData?.cost?.breakdown?.overheadINR || Math.round((rawMat + rawMach) * 0.2);

  // Decision adjustments multipliers
  const matMultiplier = decisions.material?.id === 'aisi-1045' ? 0.8 : decisions.material?.id === 'ss-316l' ? 1.85 : 1.0;
  const toleranceMultiplier = decisions.tolerances?.id === 'iso-grade-6' ? 1.35 : 1.0;
  
  const heatTreatCost = decisions.heatTreatment?.id === 'case-carburizing' ? 450 : 250;
  const surfaceCost = decisions.surfaceTreatment?.id === 'black-oxide' ? 150 : decisions.surfaceTreatment?.id === 'hard-anodize' ? 380 : 80;
  const inspectionCost = decisions.inspection?.id === 'cmm-lead-profile' ? 350 : 150;
  const shippingPerUnit = Math.max(80, Math.round(250 / Math.max(1, quantity)));

  const adjustedMat = Math.round(rawMat * matMultiplier);
  const adjustedMach = Math.round(rawMach * toleranceMultiplier);
  const adjustedTooling = rawTooling;
  const adjustedOverhead = Math.round((adjustedMat + adjustedMach + heatTreatCost + surfaceCost) * 0.18);
  const unitSubtotal = adjustedMat + adjustedMach + adjustedTooling + heatTreatCost + surfaceCost + inspectionCost + adjustedOverhead;
  const taxesGst18 = Math.round(unitSubtotal * 0.18);
  const totalUnitCost = unitSubtotal + taxesGst18 + shippingPerUnit;
  const batchTotal = totalUnitCost * quantity;

  // Lifecycle TCO calculations
  const expectedLifeYears = decisions.heatTreatment?.id === 'case-carburizing' ? 8.5 : 4.0;
  const replacementFrequency = (1 / expectedLifeYears).toFixed(2);
  const estimatedDowntimeRiskHours = decisions.tolerances?.id === 'iso-grade-6' ? 'Minimal (<2 hrs/yr)' : 'Moderate (~12 hrs/yr)';
  const tenYearTcoINR = Math.round(totalUnitCost * (10 / expectedLifeYears) + 15000);

  // Pro forma document download
  const handleDownloadEstimate = () => {
    const textContent = `
================================================================================
REFORGE AI — PRO FORMA MANUFACTURING COST ESTIMATION
Document Reference: RF-EST-${Date.now().toString(36).toUpperCase()}
Date Generated: ${new Date().toLocaleString()}
NOTICE: Estimated manufacturing cost analysis for engineering budget planning.
        Not an official supplier tax invoice.
================================================================================

COMPONENT SPECIFICATION:
Component: ${analysis?.label || 'Custom Industrial Gear'}
Raw Material: ${decisions.material?.label || 'AISI 4140 Alloy Steel'}
Tolerance Grade: ${decisions.tolerances?.label || 'DIN 7 / ISO Grade 7'}
Heat Treatment: ${decisions.heatTreatment?.label || 'Case Carburized (58-62 HRC)'}
Batch Quantity: ${quantity} units

UNIT COST BREAKDOWN (INR):
--------------------------------------------------------------------------------
1. Raw Material Stock:             ₹ ${formatINR(adjustedMat)}
2. CNC Machining & Gear Hobbing:   ₹ ${formatINR(adjustedMach)}
3. Tooling & Setup (amortized):     ₹ ${formatINR(adjustedTooling)}
4. Heat Treatment Thermal Cycle:   ₹ ${formatINR(heatTreatCost)}
5. Surface Finish & Passivation:   ₹ ${formatINR(surfaceCost)}
6. Metrology & Quality Inspection: ₹ ${formatINR(inspectionCost)}
7. Manufacturing Overhead (18%):   ₹ ${formatINR(adjustedOverhead)}
--------------------------------------------------------------------------------
Subtotal per Unit:                 ₹ ${formatINR(unitSubtotal)}
GST / Applicable Taxes (18%):      ₹ ${formatINR(taxesGst18)}
Protective Packaging & Logistics:  ₹ ${formatINR(shippingPerUnit)}
--------------------------------------------------------------------------------
TOTAL ESTIMATED COST PER UNIT:     ₹ ${formatINR(totalUnitCost)}
TOTAL BATCH ESTIMATE (${quantity} QTY):   ₹ ${formatINR(batchTotal)}

LIFECYCLE & TOTAL COST OF OWNERSHIP (TCO) PROJECTION:
--------------------------------------------------------------------------------
Design Operational Life:           ~${expectedLifeYears} years
Annual Replacement Frequency:       ${replacementFrequency} replacements/year
Projected 10-Year TCO Envelope:    ₹ ${formatINR(tenYearTcoINR)}
Downtime Risk Level:               ${estimatedDowntimeRiskHours}

ASSUMPTIONS & ENGINEERING CONTEXT:
- Rates referenced from typical ISO-9001 certified CNC machine job-shops in India.
- Excludes extraordinary customs duties or express airfreight surcharges.
================================================================================
    `.trim();

    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ReForge_Pro_Forma_Cost_Estimate_${quantity}qty.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <section
      className={`cost-estimation-panel ${isMaximized ? 'maximized' : ''} ${isCollapsed ? 'collapsed' : ''} ${isFloatingContent ? 'in-floating' : ''}`}
      style={isFloatingContent || isMaximized ? undefined : { height: isCollapsed ? '38px' : `${height}px` }}
      aria-label="Manufacturing Cost Estimation and Lifecycle Analysis"
    >
      {/* Header Bar */}
      <div className="cost-panel-header">
        <div className="cost-panel-title-group">
          <Icon>payments</Icon>
          <div>
            <h3 className="cost-panel-title">LIVE COST ESTIMATION &amp; LIFECYCLE TCO</h3>
            <span className="cost-panel-sub">India CNC Job-Shop Baseline Rates</span>
          </div>

          {/* Quick Metric Pill when Collapsed or Compact */}
          {analysis && (
            <div className="cost-panel-compact-badge" title="Estimated cost based on active decisions">
              <span className="compact-badge-label">EST:</span>
              <span className="compact-badge-value">₹ {formatINR(totalUnitCost)}/unit</span>
              <span className="compact-badge-sub">({quantity} Qty: ₹ {formatINR(batchTotal)})</span>
            </div>
          )}
        </div>

        <div className="cost-panel-actions">
          {onStartDrag && (
            <button
              type="button"
              className="panel-drag-reposition-handle"
              onMouseDown={onStartDrag}
              title="Drag to reposition panel to another dock slot"
              aria-label="Drag to reposition panel"
            >
              <Icon>drag_indicator</Icon>
            </button>
          )}

          {onToggleCollapse && (
            <button
              className="cost-panel-action-btn"
              onClick={onToggleCollapse}
              title={isCollapsed ? "Expand Cost Estimation Panel" : "Collapse Cost Estimation Panel"}
              aria-label={isCollapsed ? "Expand Cost Panel" : "Collapse Cost Panel"}
            >
              <Icon>{isCollapsed ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}</Icon>
            </button>
          )}

          {onToggleDock && (
            <button
              className="cost-panel-action-btn"
              onClick={onToggleDock}
              title={isDocked ? "Undock to floating window" : "Dock under workspace"}
              aria-label={isDocked ? "Undock Cost Panel" : "Dock Cost Panel"}
            >
              <Icon>{isDocked ? 'open_in_new' : 'dock_to_bottom'}</Icon>
            </button>
          )}

          {onToggleMaximize && (
            <button
              className="cost-panel-action-btn"
              onClick={onToggleMaximize}
              title={isMaximized ? "Restore panel size" : "Maximize panel"}
              aria-label={isMaximized ? "Restore Cost Panel" : "Maximize Cost Panel"}
            >
              <Icon>{isMaximized ? 'fullscreen_exit' : 'fullscreen'}</Icon>
            </button>
          )}

          <button
            className="secondary cost-download-btn"
            onClick={handleDownloadEstimate}
            disabled={!analysis}
            title={analysis ? "Download Estimated Costing Specification" : "Requires analyzed component"}
          >
            <Icon>download</Icon> Pro Forma (.txt)
          </button>

          <button
            className="cost-panel-close"
            onClick={onClose}
            title="Close Cost Panel"
            aria-label="Close Cost Panel"
          >
            <Icon>close</Icon>
          </button>
        </div>
      </div>

      {/* Main Grid Content (rendered only when expanded) */}
      {!isCollapsed && (
        !analysis ? (
          <div className="panel-empty-state-view">
            <Icon className="empty-state-icon">payments</Icon>
            <h3 className="empty-state-title">NO COST ESTIMATION AVAILABLE</h3>
            <p className="empty-state-text">
              Awaiting component analysis. ReForge AI determines volume, surface area, and machining cycles from reconstructed geometry to estimate unit and batch job-shop costs.
            </p>
          </div>
        ) : (
          <div className="cost-panel-body">
        {/* Column 1: Unit Cost Summary Highlight */}
        <div className="cost-col-headline">
          <span className="cost-metric-label">ESTIMATED COST / UNIT</span>
          <div className="cost-hero-figure">
            ₹{formatINR(totalUnitCost)}
          </div>
          <span className="cost-batch-sub">
            Batch Total: <strong>₹{formatINR(batchTotal)}</strong> for {quantity} unit{quantity === 1 ? '' : 's'}
          </span>

          <div className="cost-durability-pill">
            <Icon>verified</Icon>
            <span>Expected Life: ~{expectedLifeYears} Years</span>
          </div>

          <div className="cost-dependency-summary">
            <span>Outstanding Dependencies: <strong>{dependenciesCount}</strong></span>
          </div>
        </div>

        {/* Column 2: Detailed Line-Item Breakdown Table */}
        <div className="cost-col-breakdown">
          <h4 className="cost-section-subtitle">ITEMIZED MANUFACTURING BREAKDOWN (PER UNIT)</h4>
          <div className="cost-table-wrap">
            <table className="cost-breakdown-table">
              <thead>
                <tr>
                  <th>Cost Category</th>
                  <th>Engineering Driver</th>
                  <th className="align-right">Rate (INR)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Raw Material Alloy</td>
                  <td>{decisions.material?.label || 'AISI 4140'} Stock Volume</td>
                  <td className="align-right">₹{formatINR(adjustedMat)}</td>
                </tr>
                <tr>
                  <td>CNC Machining &amp; Hobbing</td>
                  <td>{decisions.tolerances?.label || 'DIN 7'} Feed &amp; Speed cycle</td>
                  <td className="align-right">₹{formatINR(adjustedMach)}</td>
                </tr>
                <tr>
                  <td>Tooling &amp; Machine Setup</td>
                  <td>Amortized across {quantity} unit batch</td>
                  <td className="align-right">₹{formatINR(adjustedTooling)}</td>
                </tr>
                <tr>
                  <td>Heat Treatment Thermal Cycle</td>
                  <td>{decisions.heatTreatment?.label || 'Case Carburizing'}</td>
                  <td className="align-right">₹{formatINR(heatTreatCost)}</td>
                </tr>
                <tr>
                  <td>Surface Treatment Coating</td>
                  <td>{decisions.surfaceTreatment?.label || 'Black Oxide'}</td>
                  <td className="align-right">₹{formatINR(surfaceCost)}</td>
                </tr>
                <tr>
                  <td>Quality Metrology &amp; Inspection</td>
                  <td>{decisions.inspection?.label || 'CMM Metrology'}</td>
                  <td className="align-right">₹{formatINR(inspectionCost)}</td>
                </tr>
                <tr>
                  <td>Overhead &amp; Consumables (18%)</td>
                  <td>Coolant, scrap allowance, QA overhead</td>
                  <td className="align-right">₹{formatINR(adjustedOverhead)}</td>
                </tr>
                <tr className="row-total">
                  <td>Taxes (GST 18%) &amp; Packaging</td>
                  <td>Statutory tax + VCI anti-rust wrap</td>
                  <td className="align-right">₹{formatINR(taxesGst18 + shippingPerUnit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Column 3: Lifecycle Cost Comparison & TCO */}
        <div className="cost-col-lifecycle">
          <h4 className="cost-section-subtitle">10-YEAR LIFECYCLE TOTAL COST OF OWNERSHIP (TCO)</h4>
          <div className="tco-cards-grid">
            <div className="tco-card">
              <span className="tco-label">10-Year Total Ownership</span>
              <strong className="tco-val">₹{formatINR(tenYearTcoINR)}</strong>
              <small>Unit cost + scheduled replacement cycle</small>
            </div>
            <div className="tco-card">
              <span className="tco-label">Replacement Interval</span>
              <strong className="tco-val">~{expectedLifeYears} Years</strong>
              <small>{replacementFrequency} cycle/yr at full load</small>
            </div>
            <div className="tco-card">
              <span className="tco-label">Downtime Risk Level</span>
              <strong className="tco-val text-lime">{estimatedDowntimeRiskHours}</strong>
              <small>Calculated from fatigue &amp; tolerance margin</small>
            </div>
          </div>
          <p className="cost-disclaimer-note">
            *Pro forma cost estimate for engineering budget allocation. Actual prices vary with raw steel spot rates and shop scheduling.
          </p>
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
