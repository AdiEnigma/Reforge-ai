import React, { useState, useEffect } from 'react';
import { resolveLabel } from '../lib/reconstruct.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function ReportEditorDialog({
  isOpen,
  onClose,
  analysis,
  decisions = {},
  quantity = 1,
  mfgData,
  images = [],
}) {
  const [draft, setDraft] = useState({
    title: '',
    application: 'Industrial Power Transmission / Gearbox Drive Unit',
    material: '',
    quantity: 1,
    outerDiameter: 120,
    innerDiameter: 30,
    height: 28,
    teeth: 24,
    toleranceGrade: 'DIN 7 / ISO Grade 7',
    heatTreatment: 'Case Carburized (58–62 HRC, 0.8–1.2mm depth)',
    surfaceTreatment: 'Black Oxide (MIL-DTL-13924)',
    inspection: 'CMM Tooth Profile & Involute Lead Inspection (EN 10204 3.1)',
    reasoning: '',
    assumptions: 'All mating interfaces physically verified with calibrated micrometers prior to CNC spindle cycle.',
    includeDrawing: true,
    include3dRender: true,
  });

  const [savedNotice, setSavedNotice] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [dialogPos, setDialogPos] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });

  const handleMouseDownHeader = (e) => {
    if (isMaximized) return;
    if (e.target.closest('button') || e.target.closest('input')) return;
    isDraggingRef.current = true;
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posX: dialogPos.x,
      posY: dialogPos.y,
    };
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEv) => {
      if (!isDraggingRef.current) return;
      const dx = moveEv.clientX - dragStartRef.current.mouseX;
      const dy = moveEv.clientY - dragStartRef.current.mouseY;
      setDialogPos({
        x: dragStartRef.current.posX + dx,
        y: dragStartRef.current.posY + dy,
      });
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Initialize draft from analysis & decisions or existing saved draft
  useEffect(() => {
    if (!analysis) return;
    const label = resolveLabel(analysis);
    const saved = localStorage.getItem('reforge_report_draft');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setDraft(parsed);
        return;
      } catch {
        // ignore and use fresh defaults
      }
    }

    setDraft({
      title: label,
      application: 'Industrial Power Transmission / High-Torque Gearbox',
      material: decisions.material?.label || analysis.materialEstimate || 'AISI 4140 Alloy Steel',
      quantity: quantity || 1,
      outerDiameter: decisions.outerDiameter || analysis.dimensions?.outerDiameter || 120,
      innerDiameter: decisions.innerDiameter || analysis.dimensions?.innerDiameter || 30,
      height: decisions.height || analysis.dimensions?.height || analysis.dimensions?.thickness || 28,
      teeth: decisions.teeth || analysis.teeth || 24,
      toleranceGrade: decisions.tolerances?.label || 'DIN 7 / ISO Grade 7',
      heatTreatment: decisions.heatTreatment?.label || 'Case Carburized (58–62 HRC)',
      surfaceTreatment: decisions.surfaceTreatment?.label || 'Black Oxide Finish',
      inspection: decisions.inspection?.label || 'CMM Profile & Runout Verification',
      reasoning: analysis.reasoning || 'Involute spur tooth profile synthesized from multi-view geometric reconstruction.',
      assumptions: 'Critical bore tolerance must be verified with cylinder bore gauge prior to press-fit assembly.',
      includeDrawing: true,
      include3dRender: true,
    });
  }, [analysis, decisions, quantity]);

  if (!isOpen) return null;

  const handleChange = (field, value) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveDraft = () => {
    localStorage.setItem('reforge_report_draft', JSON.stringify(draft));
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2500);
  };

  const handlePrintPdf = () => {
    handleSaveDraft();
    window.print();
  };

  return (
    <div
      className="report-dialog-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Engineering Specification Report Editor"
    >
      <div
        className={`report-editor-card ${isMaximized ? 'maximized' : ''}`}
        style={
          isMaximized
            ? { width: '100vw', height: '100vh', maxHeight: '100vh', borderRadius: 0, border: 'none' }
            : dialogPos.x || dialogPos.y
            ? { transform: `translate(${dialogPos.x}px, ${dialogPos.y}px)` }
            : undefined
        }
        onClick={(e) => e.stopPropagation()}
      >
        {/* Editor Top Bar */}
        <div
          className="report-editor-topbar"
          onMouseDown={handleMouseDownHeader}
          style={{ cursor: isMaximized ? 'default' : 'move' }}
          title={isMaximized ? undefined : "Drag to reposition dialog"}
        >
          <div className="report-editor-title-group">
            <Icon>description</Icon>
            <div>
              <h2 className="editor-modal-title">ENGINEERING SPECIFICATION &amp; AUDIT REPORT EDITOR</h2>
              <span className="editor-modal-sub">Review and edit technical parameters before PDF specification export</span>
            </div>
          </div>
          <div className="editor-modal-actions">
            {savedNotice && <span className="save-badge-notice">✓ Draft Saved to Local Storage</span>}
            <button className="secondary" onClick={handleSaveDraft} title="Save draft locally">
              <Icon>save</Icon> SAVE DRAFT
            </button>
            <button className="primary" onClick={handlePrintPdf} title="Generate and export PDF">
              <Icon>picture_as_pdf</Icon> GENERATE PDF
            </button>
            <button
              className="secondary btn-close-modal"
              onClick={() => setIsMaximized(m => !m)}
              title={isMaximized ? "Restore Dialog Size" : "Maximize Dialog"}
              aria-label={isMaximized ? "Restore Dialog" : "Maximize Dialog"}
            >
              <Icon>{isMaximized ? 'fullscreen_exit' : 'fullscreen'}</Icon>
            </button>
            <button className="secondary btn-close-modal" onClick={onClose} aria-label="Close dialog">
              <Icon>close</Icon>
            </button>
          </div>
        </div>

        {/* Editor Body: Form Fields */}
        <div className="report-editor-body">
          {/* Section 1: Component Header */}
          <section className="editor-section">
            <h3 className="editor-section-heading">
              <Icon>category</Icon> 1. COMPONENT IDENTIFICATION &amp; APPLICATION
            </h3>
            <div className="editor-field-row-2">
              <div className="editor-field">
                <label>Component Title / Nomenclature</label>
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => handleChange('title', e.target.value)}
                />
              </div>
              <div className="editor-field">
                <label>Intended Industrial Application</label>
                <input
                  type="text"
                  value={draft.application}
                  onChange={(e) => handleChange('application', e.target.value)}
                />
              </div>
            </div>
          </section>

          {/* Section 2: Reconstructed Dimensions */}
          <section className="editor-section">
            <h3 className="editor-section-heading">
              <Icon>straighten</Icon> 2. CRITICAL ENGINEERING DIMENSIONS
            </h3>
            <div className="editor-field-grid-4">
              <div className="editor-field">
                <label>Outer Diameter (OD, mm)</label>
                <div className="editor-numeric-stepper">
                  <button onClick={() => handleChange('outerDiameter', Math.max(1, draft.outerDiameter - 1))}>-</button>
                  <input
                    type="number"
                    value={draft.outerDiameter}
                    onChange={(e) => handleChange('outerDiameter', parseFloat(e.target.value) || 0)}
                  />
                  <button onClick={() => handleChange('outerDiameter', draft.outerDiameter + 1)}>+</button>
                </div>
              </div>

              <div className="editor-field">
                <label>Bore Diameter (ID, mm)</label>
                <div className="editor-numeric-stepper">
                  <button onClick={() => handleChange('innerDiameter', Math.max(1, draft.innerDiameter - 1))}>-</button>
                  <input
                    type="number"
                    value={draft.innerDiameter}
                    onChange={(e) => handleChange('innerDiameter', parseFloat(e.target.value) || 0)}
                  />
                  <button onClick={() => handleChange('innerDiameter', draft.innerDiameter + 1)}>+</button>
                </div>
              </div>

              <div className="editor-field">
                <label>Face Width (mm)</label>
                <div className="editor-numeric-stepper">
                  <button onClick={() => handleChange('height', Math.max(1, draft.height - 1))}>-</button>
                  <input
                    type="number"
                    value={draft.height}
                    onChange={(e) => handleChange('height', parseFloat(e.target.value) || 0)}
                  />
                  <button onClick={() => handleChange('height', draft.height + 1)}>+</button>
                </div>
              </div>

              <div className="editor-field">
                <label>Gear Teeth Count (z)</label>
                <div className="editor-numeric-stepper">
                  <button onClick={() => handleChange('teeth', Math.max(6, draft.teeth - 1))}>-</button>
                  <input
                    type="number"
                    value={draft.teeth}
                    onChange={(e) => handleChange('teeth', parseInt(e.target.value, 10) || 6)}
                  />
                  <button onClick={() => handleChange('teeth', draft.teeth + 1)}>+</button>
                </div>
              </div>
            </div>
          </section>

          {/* Section 3: Material & Manufacturing Specification */}
          <section className="editor-section">
            <h3 className="editor-section-heading">
              <Icon>factory</Icon> 3. MANUFACTURING &amp; METALLURGY SPECIFICATION
            </h3>
            <div className="editor-field-row-2">
              <div className="editor-field">
                <label>Material Specification Standard</label>
                <select
                  value={draft.material}
                  onChange={(e) => handleChange('material', e.target.value)}
                >
                  <option value="AISI 4140 Alloy Steel (Chromoly)">AISI 4140 Alloy Steel (Chromoly)</option>
                  <option value="AISI 1045 Medium Carbon Steel">AISI 1045 Medium Carbon Steel</option>
                  <option value="AISI 316L Stainless Steel">AISI 316L Stainless Steel</option>
                  <option value="7075-T6 Aerospace Aluminum">7075-T6 Aerospace Aluminum</option>
                  <option value="C93200 Bearing Bronze">C93200 Bearing Bronze</option>
                </select>
              </div>

              <div className="editor-field">
                <label>Tolerance Standard &amp; Fit Class</label>
                <select
                  value={draft.toleranceGrade}
                  onChange={(e) => handleChange('toleranceGrade', e.target.value)}
                >
                  <option value="DIN 7 / ISO Grade 7 (Standard Precision)">DIN 7 / ISO Grade 7 (Standard Precision)</option>
                  <option value="DIN 6 / ISO Grade 6 (Ground Low Backlash)">DIN 6 / ISO Grade 6 (Ground Low Backlash)</option>
                  <option value="Commercial Grade ±0.1mm (General)">Commercial Grade ±0.1mm (General)</option>
                </select>
              </div>
            </div>

            <div className="editor-field-row-3">
              <div className="editor-field">
                <label>Heat Treatment &amp; Core Hardness</label>
                <input
                  type="text"
                  value={draft.heatTreatment}
                  onChange={(e) => handleChange('heatTreatment', e.target.value)}
                />
              </div>

              <div className="editor-field">
                <label>Surface Finish &amp; Coating</label>
                <input
                  type="text"
                  value={draft.surfaceTreatment}
                  onChange={(e) => handleChange('surfaceTreatment', e.target.value)}
                />
              </div>

              <div className="editor-field">
                <label>Inspection Protocol &amp; Metrology</label>
                <input
                  type="text"
                  value={draft.inspection}
                  onChange={(e) => handleChange('inspection', e.target.value)}
                />
              </div>
            </div>
          </section>

          {/* Section 4: Technical Reasoning & Assumptions */}
          <section className="editor-section">
            <h3 className="editor-section-heading">
              <Icon>psychology</Icon> 4. TECHNICAL REASONING &amp; FIELD ASSUMPTIONS
            </h3>
            <div className="editor-field">
              <label>Reconstruction Engineering Justification</label>
              <textarea
                rows="3"
                value={draft.reasoning}
                onChange={(e) => handleChange('reasoning', e.target.value)}
              />
            </div>
            <div className="editor-field">
              <label>Assumptions &amp; Physical Verification Directives</label>
              <textarea
                rows="2"
                value={draft.assumptions}
                onChange={(e) => handleChange('assumptions', e.target.value)}
              />
            </div>
          </section>

          {/* Section 5: Optional Attachments */}
          <section className="editor-section">
            <h3 className="editor-section-heading">
              <Icon>attachment</Icon> 5. REPORT ATTACHMENTS
            </h3>
            <div className="editor-attachments-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={draft.includeDrawing}
                  onChange={(e) => handleChange('includeDrawing', e.target.checked)}
                />
                <span>Include 2D Dimensioned Engineering Drawing Projections</span>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={draft.include3dRender}
                  onChange={(e) => handleChange('include3dRender', e.target.checked)}
                />
                <span>Include 3D Isometric Solid &amp; Stress Heatmap Renderings</span>
              </label>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
export default ReportEditorDialog;
