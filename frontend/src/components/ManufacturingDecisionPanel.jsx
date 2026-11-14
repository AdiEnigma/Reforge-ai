import React, { useState, useRef } from 'react';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function ManufacturingDecisionPanel({
  isOpen,
  onClose,
  width,
  onResize,
  // Customization
  isDocked = true,
  onToggleDock,
  isMaximized = false,
  onToggleMaximize,
  isFloatingContent = false,
  currentSlot = 'right',
  onMoveSlot,
  onStartDrag,
  analysis,
  decisions,
  onChangeDecision,
  dependencies = [],
  quantity,
  onChangeQuantity,
}) {
  const [expandedCat, setExpandedCat] = useState('material');
  const isDraggingRef = useRef(false);

  const handleMouseDownResizer = (e) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent) => {
      if (!isDraggingRef.current) return;
      const maxW = Math.max(320, window.innerWidth - 380);
      const newWidth = Math.max(320, Math.min(Math.min(800, maxW), window.innerWidth - moveEvent.clientX));
      onResize?.(newWidth);
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

  const categories = [
    {
      id: 'geometry',
      num: 1,
      title: 'Geometry & Dimensions',
      icon: 'straighten',
      summary: `OD: ${decisions.outerDiameter || analysis?.dimensions?.outerDiameter || 100}mm · ID: ${decisions.innerDiameter || analysis?.dimensions?.innerDiameter || 25}mm`,
      isComplete: true,
      hasDependency: dependencies.some(d => d.target === 'geometry'),
    },
    {
      id: 'material',
      num: 2,
      title: 'Material Selection',
      icon: 'layers',
      summary: decisions.material?.label || 'AISI 4140 Alloy Steel',
      isComplete: Boolean(decisions.material),
      hasDependency: dependencies.some(d => d.target === 'material'),
    },
    {
      id: 'process',
      num: 3,
      title: 'Manufacturing Process',
      icon: 'precision_manufacturing',
      summary: decisions.process?.label || 'CNC Gear Hobbing + Milling',
      isComplete: Boolean(decisions.process),
      hasDependency: dependencies.some(d => d.target === 'process'),
    },
    {
      id: 'surface',
      num: 4,
      title: 'Surface Treatment',
      icon: 'format_paint',
      summary: decisions.surfaceTreatment?.label || 'Black Oxide Finish',
      isComplete: Boolean(decisions.surfaceTreatment),
      hasDependency: dependencies.some(d => d.target === 'surface'),
    },
    {
      id: 'tolerances',
      num: 5,
      title: 'Tolerances & Fits',
      icon: 'tune',
      summary: decisions.tolerances?.label || 'DIN 7 / ISO Grade 7 Precision',
      isComplete: Boolean(decisions.tolerances),
      hasDependency: dependencies.some(d => d.target === 'tolerances'),
    },
    {
      id: 'heatTreatment',
      num: 6,
      title: 'Heat Treatment',
      icon: 'local_fire_department',
      summary: decisions.heatTreatment?.label || 'Case Hardened (58–62 HRC)',
      isComplete: Boolean(decisions.heatTreatment),
      hasDependency: dependencies.some(d => d.target === 'heatTreatment'),
    },
    {
      id: 'inspection',
      num: 7,
      title: 'Quality Inspection',
      icon: 'verified',
      summary: decisions.inspection?.label || 'CMM Profile & Lead Verification',
      isComplete: Boolean(decisions.inspection),
      hasDependency: dependencies.some(d => d.target === 'inspection'),
    },
    {
      id: 'quantity',
      num: 8,
      title: 'Batch Quantity',
      icon: 'pin',
      summary: `${quantity} unit${quantity === 1 ? '' : 's'} (Job-Shop Batch)`,
      isComplete: quantity > 0,
      hasDependency: dependencies.some(d => d.target === 'quantity'),
    },
    {
      id: 'packaging',
      num: 9,
      title: 'Packaging & Delivery',
      icon: 'inventory_2',
      summary: decisions.packaging?.label || 'VCI Anti-Corrosion Wrap + Box',
      isComplete: Boolean(decisions.packaging),
      hasDependency: dependencies.some(d => d.target === 'packaging'),
    },
  ];

  return (
    <aside
      className={`mfg-decision-panel ${isMaximized ? 'maximized' : ''} ${isFloatingContent ? 'in-floating' : ''}`}
      style={isFloatingContent || isMaximized ? undefined : { width: `${width}px` }}
      aria-label="Manufacturing Decisions Specification"
    >
      {/* Top Header */}
      <div className="mfg-decision-header">
        <div className="mfg-decision-title-group">
          <Icon>factory</Icon>
          <div>
            <h2 className="mfg-decision-title">MANUFACTURING DECISIONS</h2>
            <span className="mfg-decision-sub">9 Categories · Engineering Dependencies</span>
          </div>
        </div>

        <div className="panel-header-actions">
          {onToggleDock && (
            <button
              className="panel-action-btn"
              onClick={onToggleDock}
              title={isDocked ? "Undock to floating window" : "Dock into right rail"}
              aria-label={isDocked ? "Undock Manufacturing Panel" : "Dock Manufacturing Panel"}
            >
              <Icon>{isDocked ? 'open_in_new' : 'dock_to_right'}</Icon>
            </button>
          )}

          {onToggleMaximize && (
            <button
              className="panel-action-btn"
              onClick={onToggleMaximize}
              title={isMaximized ? "Restore panel size" : "Maximize panel"}
              aria-label={isMaximized ? "Restore Manufacturing Panel" : "Maximize Manufacturing Panel"}
            >
              <Icon>{isMaximized ? 'fullscreen_exit' : 'fullscreen'}</Icon>
            </button>
          )}

          <button
            className="mfg-decision-close"
            onClick={onClose}
            title="Close Manufacturing Panel"
            aria-label="Close Manufacturing Panel"
          >
            <Icon>close</Icon>
          </button>
        </div>
      </div>

      {/* Dependency Warning Banner if active */}
      {analysis && dependencies.length > 0 && (
        <div className="mfg-dep-banner">
          <Icon>report_problem</Icon>
          <div className="dep-banner-content">
            <strong>Decision Dependencies Flagged for Review:</strong>
            <ul>
              {dependencies.map((dep, idx) => (
                <li key={idx}>
                  <strong>{dep.title}:</strong> {dep.reason}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {!analysis ? (
        <div className="panel-empty-state-view">
          <Icon className="empty-state-icon">precision_manufacturing</Icon>
          <h3 className="empty-state-title">NO COMPONENT LOADED</h3>
          <p className="empty-state-text">
            Manufacturing decision specifications require reconstructed component geometry and dimensions. Upload component views or load a sample gear from the 3D workspace to begin engineering specification.
          </p>
        </div>
      ) : (
        /* Accordion Categories List */
        <div className="mfg-categories-accordion" role="region" aria-label="Decision Categories">
        {categories.map((cat) => {
          const isExpanded = expandedCat === cat.id;

          return (
            <div
              key={cat.id}
              className={`mfg-cat-card ${isExpanded ? 'expanded' : ''} ${cat.hasDependency ? 'has-dep' : ''}`}
            >
              <button
                className="mfg-cat-header-btn"
                onClick={() => setExpandedCat(isExpanded ? null : cat.id)}
                aria-expanded={isExpanded}
              >
                <div className="mfg-cat-icon-col">
                  <Icon>{cat.icon}</Icon>
                </div>
                <div className="mfg-cat-info-col">
                  <div className="mfg-cat-title-row">
                    <span className="mfg-cat-num">0{cat.num}</span>
                    <strong className="mfg-cat-title">{cat.title}</strong>
                    {cat.hasDependency && (
                      <span className="mfg-dep-tag" title="Affected by another decision">REVIEW REQUIRED</span>
                    )}
                  </div>
                  <div className="mfg-cat-summary">{cat.summary}</div>
                </div>
                <div className="mfg-cat-status-col">
                  <span className={`mfg-status-pill ${cat.isComplete ? 'done' : 'pending'}`}>
                    {cat.isComplete ? <Icon>check</Icon> : <Icon>schedule</Icon>}
                  </span>
                  <Icon className="mfg-chevron">{isExpanded ? 'expand_less' : 'expand_more'}</Icon>
                </div>
              </button>

              {/* Expanded Category Body */}
              {isExpanded && (
                <div className="mfg-cat-body">
                  {/* CATEGORY 1: GEOMETRY & DIMENSIONS */}
                  {cat.id === 'geometry' && (
                    <div className="mfg-opt-content">
                      <p className="mfg-opt-desc">
                        Baseline geometry reconstructed from vision and geometry recipes. Adjustments directly govern material volume envelope, CNC envelope constraints, and mating center distance.
                      </p>
                      <div className="mfg-field-grid">
                        <div className="mfg-field">
                          <label>Outer Diameter (mm)</label>
                          <input
                            type="number"
                            value={decisions.outerDiameter ?? analysis?.dimensions?.outerDiameter ?? 100}
                            onChange={(e) => onChangeDecision('outerDiameter', parseFloat(e.target.value) || 0)}
                          />
                        </div>
                        <div className="mfg-field">
                          <label>Inner Bore Diameter (mm)</label>
                          <input
                            type="number"
                            value={decisions.innerDiameter ?? analysis?.dimensions?.innerDiameter ?? 25}
                            onChange={(e) => onChangeDecision('innerDiameter', parseFloat(e.target.value) || 0)}
                          />
                        </div>
                        <div className="mfg-field">
                          <label>Face Width / Height (mm)</label>
                          <input
                            type="number"
                            value={decisions.height ?? analysis?.dimensions?.height ?? analysis?.dimensions?.thickness ?? 28}
                            onChange={(e) => onChangeDecision('height', parseFloat(e.target.value) || 0)}
                          />
                        </div>
                        <div className="mfg-field">
                          <label>Gear Teeth (z)</label>
                          <input
                            type="number"
                            value={decisions.teeth ?? analysis?.teeth ?? 24}
                            onChange={(e) => onChangeDecision('teeth', parseInt(e.target.value, 10) || 0)}
                          />
                        </div>
                      </div>
                      <div className="mfg-implication-card">
                        <strong>Engineering Implications:</strong>
                        <ul>
                          <li><strong>Load Capacity:</strong> Face width increases tooth contact area proportionally, lowering localized bending stress.</li>
                          <li><strong>Assembly Compatibility:</strong> Altering OD or tooth count shifts pitch circle and mating center distance.</li>
                        </ul>
                      </div>
                    </div>
                  )}

                  {/* CATEGORY 2: MATERIAL */}
                  {cat.id === 'material' && (
                    <div className="mfg-opt-content">
                      <p className="mfg-opt-desc">Select core engineering alloy. Governs base yield strength, fatigue endurance limit, and heat treatability.</p>
                      <div className="mfg-choice-list">
                        {[
                          {
                            id: 'aisi-4140',
                            label: 'AISI 4140 Alloy Steel (Chromoly)',
                            yieldMPa: 655,
                            hardness: '28–32 HRC (Pre-hardened)',
                            desc: 'High torsional strength, excellent impact resistance, ideal for industrial gearing.',
                            costMul: '1.0× (Baseline)',
                          },
                          {
                            id: 'aisi-1045',
                            label: 'AISI 1045 Medium Carbon Steel',
                            yieldMPa: 450,
                            hardness: '16–20 HRC (As-rolled)',
                            desc: 'Economical general-purpose steel with good machinability and surface induction hardenable.',
                            costMul: '0.75× (Economical)',
                          },
                          {
                            id: 'ss-316l',
                            label: 'AISI 316L Stainless Steel',
                            yieldMPa: 290,
                            hardness: '85 HRB',
                            desc: 'Superior corrosion resistance for food/chemical service; lower tooth bending fatigue limit.',
                            costMul: '1.85× (Corrosion Special)',
                          },
                          {
                            id: 'al-7075-t6',
                            label: '7075-T6 Aerospace Aluminum',
                            yieldMPa: 505,
                            hardness: '150 HB',
                            desc: 'High strength-to-weight ratio for weight-critical systems; requires hard anodizing for wear.',
                            costMul: '1.4× (Lightweight)',
                          },
                        ].map((m) => (
                          <div
                            key={m.id}
                            className={`mfg-choice-card ${(decisions.material?.id || 'aisi-4140') === m.id ? 'selected' : ''}`}
                            onClick={() => onChangeDecision('material', m)}
                          >
                            <div className="choice-head">
                              <strong>{m.label}</strong>
                              <span className="choice-badge">{m.costMul}</span>
                            </div>
                            <p className="choice-desc">{m.desc}</p>
                            <div className="choice-props">
                              <span>Yield Strength: {m.yieldMPa} MPa</span>
                              <span>Nominal Hardness: {m.hardness}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mfg-implication-card">
                        <strong>Engineering Implications:</strong>
                        <ul>
                          <li><strong>Durability:</strong> AISI 4140 provides 45% higher fatigue limit compared to carbon steel.</li>
                          <li><strong>Wear:</strong> Aluminum or Austenitic Stainless will gall rapidly without specialized coatings or lubricants.</li>
                        </ul>
                      </div>
                    </div>
                  )}

                  {/* CATEGORY 3: MANUFACTURING PROCESS */}
                  {cat.id === 'process' && (
                    <div className="mfg-opt-content">
                      <p className="mfg-opt-desc">Primary machining and tooth generation process route.</p>
                      <div className="mfg-choice-list">
                        {[
                          {
                            id: 'hobbing-cnc',
                            label: 'CNC Gear Hobbing + Milling',
                            leadTime: '8–12 days',
                            accuracy: 'DIN 7 / AGMA 10',
                            desc: 'Continuous indexing process delivering high throughput and low tooth spacing error.',
                          },
                          {
                            id: 'wire-edm',
                            label: 'Wire Electrical Discharge Machining (EDM)',
                            leadTime: '12–15 days',
                            accuracy: 'DIN 6 / AGMA 11',
                            desc: 'Erosion method capable of cutting hardened alloys without tool force or burrs; higher unit cost.',
                          },
                          {
                            id: 'multi-axis-milling',
                            label: '5-Axis Simultaneous CNC Profiling',
                            leadTime: '10–14 days',
                            accuracy: 'DIN 8 / AGMA 9',
                            desc: 'Flexible for non-standard spiral/bevel forms and integrated shafts; slower cycle time.',
                          },
                        ].map((p) => (
                          <div
                            key={p.id}
                            className={`mfg-choice-card ${(decisions.process?.id || 'hobbing-cnc') === p.id ? 'selected' : ''}`}
                            onClick={() => onChangeDecision('process', p)}
                          >
                            <div className="choice-head">
                              <strong>{p.label}</strong>
                              <span className="choice-badge">{p.accuracy}</span>
                            </div>
                            <p className="choice-desc">{p.desc}</p>
                            <div className="choice-props">
                              <span>Lead Time: {p.leadTime}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* CATEGORY 4: SURFACE TREATMENT */}
                  {cat.id === 'surface' && (
                    <div className="mfg-opt-content">
                      <p className="mfg-opt-desc">Chemical or electrochemical surface passivation and corrosion barrier.</p>
                      <div className="mfg-choice-list">
                        {[
                          { id: 'black-oxide', label: 'Black Oxide (MIL-DTL-13924)', desc: 'Zero dimensional buildup (sub-micron); provides lubricity and mild indoor rust protection.' },
                          { id: 'manganese-phosphate', label: 'Manganese Phosphate (Parkerizing)', desc: 'Micro-crystalline coating holding oil film; excellent break-in scuffing protection.' },
                          { id: 'hard-anodize', label: 'Hardcoat Anodizing Type III', desc: '50µm penetration layer for aluminum alloys; glass-hard wear surface (60 HRC equivalent).' },
                          { id: 'as-machined', label: 'As-Machined (Light Anti-Rust Oil)', desc: 'No chemical barrier; lowest cost; requires immediate operational oil bath.' },
                        ].map((s) => (
                          <div
                            key={s.id}
                            className={`mfg-choice-card ${(decisions.surfaceTreatment?.id || 'black-oxide') === s.id ? 'selected' : ''}`}
                            onClick={() => onChangeDecision('surfaceTreatment', s)}
                          >
                            <strong>{s.label}</strong>
                            <p className="choice-desc">{s.desc}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* CATEGORY 5: TOLERANCES */}
                  {cat.id === 'tolerances' && (
                    <div className="mfg-opt-content">
                      <p className="mfg-opt-desc">Dimensional accuracy class and mating interface fit standards.</p>
                      <div className="mfg-choice-list">
                        {[
                          { id: 'iso-grade-7', label: 'DIN 7 / ISO Grade 7 (Standard Precision)', desc: 'Pitch error < 18µm. Standard for industrial drives, machine tools, and reduction units.' },
                          { id: 'iso-grade-6', label: 'DIN 6 / ISO Grade 6 (High Precision Ground)', desc: 'Pitch error < 12µm. Low backlash, reduced acoustic noise; requires gear tooth grinding pass.' },
                          { id: 'commercial-grade-9', label: 'Commercial Grade ±0.1mm (General)', desc: 'Economical tolerance envelope for slow-speed conveyors and non-critical linkages.' },
                        ].map((t) => (
                          <div
                            key={t.id}
                            className={`mfg-choice-card ${(decisions.tolerances?.id || 'iso-grade-7') === t.id ? 'selected' : ''}`}
                            onClick={() => onChangeDecision('tolerances', t)}
                          >
                            <strong>{t.label}</strong>
                            <p className="choice-desc">{t.desc}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* CATEGORY 6: HEAT TREATMENT */}
                  {cat.id === 'heatTreatment' && (
                    <div className="mfg-opt-content">
                      <p className="mfg-opt-desc">Thermal processing to achieve high surface hardness with ductile core toughness.</p>
                      <div className="mfg-choice-list">
                        {[
                          { id: 'case-carburizing', label: 'Case Carburizing (58–62 HRC, 0.8–1.2mm Case)', desc: 'Standard for high-power gearing. Maximum tooth contact fatigue resistance with shock-absorbing core.' },
                          { id: 'induction-hardening', label: 'Induction Tooth Contour Hardening (52–56 HRC)', desc: 'Localized tooth flank heating; leaves bore and hub unhardened for easy subsequent machining.' },
                          { id: 'nitriding', label: 'Gas Nitriding (600–700 HV, 0.3mm Case)', desc: 'Low distortion sub-critical process; no quench required; maintains precision dimensions.' },
                          { id: 'through-hardened', label: 'Quench & Temper Through-Hardened (32–36 HRC)', desc: 'Uniform intermediate hardness throughout; balanced strength without brittle case risk.' },
                        ].map((h) => (
                          <div
                            key={h.id}
                            className={`mfg-choice-card ${(decisions.heatTreatment?.id || 'case-carburizing') === h.id ? 'selected' : ''}`}
                            onClick={() => onChangeDecision('heatTreatment', h)}
                          >
                            <strong>{h.label}</strong>
                            <p className="choice-desc">{h.desc}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* CATEGORY 7: QUALITY INSPECTION */}
                  {cat.id === 'inspection' && (
                    <div className="mfg-opt-content">
                      <p className="mfg-opt-desc">Metrology protocol and compliance inspection documentation.</p>
                      <div className="mfg-choice-list">
                        {[
                          { id: 'cmm-lead-profile', label: 'CMM Tooth Profile & Involute Lead Inspection (EN 10204 3.1)', desc: '3D coordinate metrology verifying total profile error (Fα) and lead helix deviation (Fβ).' },
                          { id: 'double-flank-roll', label: 'Double-Flank Composite Roll Testing', desc: 'Fast kinematic mesh inspection against master gear verifying radial composite runout (Fi).' },
                          { id: 'mpi-ndt', label: 'Magnetic Particle Inspection (MPI) + Hardness Check', desc: 'Non-destructive surface crack detection on root fillets post heat treatment.' },
                        ].map((i) => (
                          <div
                            key={i.id}
                            className={`mfg-choice-card ${(decisions.inspection?.id || 'cmm-lead-profile') === i.id ? 'selected' : ''}`}
                            onClick={() => onChangeDecision('inspection', i)}
                          >
                            <strong>{i.label}</strong>
                            <p className="choice-desc">{i.desc}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* CATEGORY 8: QUANTITY */}
                  {cat.id === 'quantity' && (
                    <div className="mfg-opt-content">
                      <p className="mfg-opt-desc">Specify production volume to amortize CNC setup, fixture tooling, and quality calibration costs.</p>
                      <div className="mfg-qty-controller">
                        <label htmlFor="mfg-batch-qty">Production Batch Size (Units)</label>
                        <div className="qty-stepper-row">
                          <button
                            className="qty-btn"
                            onClick={() => onChangeQuantity(Math.max(1, quantity - 1))}
                            disabled={quantity <= 1}
                          >
                            -
                          </button>
                          <input
                            id="mfg-batch-qty"
                            type="number"
                            min="1"
                            max="100000"
                            value={quantity}
                            onChange={(e) => onChangeQuantity(Math.max(1, Math.min(100000, parseInt(e.target.value, 10) || 1)))}
                          />
                          <button
                            className="qty-btn"
                            onClick={() => onChangeQuantity(Math.min(100000, quantity + 1))}
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <div className="mfg-qty-tier-pills">
                        {[1, 5, 10, 50, 100, 500].map((q) => (
                          <button
                            key={q}
                            className={`tier-pill ${quantity === q ? 'active' : ''}`}
                            onClick={() => onChangeQuantity(q)}
                          >
                            {q} {q === 1 ? 'unit' : 'units'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* CATEGORY 9: PACKAGING & DELIVERY */}
                  {cat.id === 'packaging' && (
                    <div className="mfg-opt-content">
                      <p className="mfg-opt-desc">Preservation packing to prevent tooth edge nicks and atmospheric oxidation during transit.</p>
                      <div className="mfg-choice-list">
                        {[
                          { id: 'vci-sealed', label: 'VCI Vapor-Inhibitor Sealed Bag + Foam Cradles', desc: 'Active corrosion inhibition protecting machined ground faces up to 24 months in storage.' },
                          { id: 'wooden-crate', label: 'Reinforced ISPM-15 Wooden Crate (Heavy Freight)', desc: 'Shock-isolated compartmentalized transport for gears exceeding 20 kg.' },
                          { id: 'bulk-industrial', label: 'Industrial Corrugated Carton with Oil Paper', desc: 'Standard domestic freight packing for immediate assembly-line ingestion.' },
                        ].map((pk) => (
                          <div
                            key={pk.id}
                            className={`mfg-choice-card ${(decisions.packaging?.id || 'vci-sealed') === pk.id ? 'selected' : ''}`}
                            onClick={() => onChangeDecision('packaging', pk)}
                          >
                            <strong>{pk.label}</strong>
                            <p className="choice-desc">{pk.desc}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
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
