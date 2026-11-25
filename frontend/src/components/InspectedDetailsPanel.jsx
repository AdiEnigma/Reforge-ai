import React from 'react';
import { dimensionList, resolveLabel } from '../lib/reconstruct.js';
import { ToothCountOverlay } from './ToothCountOverlay.jsx';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

function formatDimValue(label, value) {
  if (value == null || !isFinite(value)) return 'Unknown';
  const num = Number(value);
  const l = String(label).toUpperCase();
  if (l.includes('TEETH')) return `${Math.round(num)} T`;
  if (l.includes('MODULE')) return `${num.toFixed(2)} mm`;
  if (l.includes('HELIX')) return `${num.toFixed(1)}°`;
  return `${num.toFixed(1)} mm`;
}

function getDimTolerance(status) {
  if (status === 'MEASURED') return '±0.15 mm';
  if (status === 'ESTIMATED') return '±0.50 mm';
  return 'Requires Scale Ref';
}

function getDimSymbol(label) {
  const l = String(label).toUpperCase();
  if (l.includes('OUTER') || l.includes('INNER') || l.includes('Ø') || l.includes('DIAMETER')) return 'Ø';
  if (l.includes('HEIGHT') || l.includes('LENGTH')) return 'L';
  if (l.includes('THICKNESS') || l.includes('WIDTH')) return 'W';
  if (l.includes('TEETH')) return 'z';
  if (l.includes('MODULE')) return 'm';
  if (l.includes('HELIX')) return 'β';
  return '•';
}

export function InspectedDetailsPanel({
  analysis,
  features = [],
  selectedFeatureId,
  hoveredFeatureId,
  onSelectFeature,
  onHoverFeature,
  dims: dimsActive = false,
  onToggleDims,
  images = [],
}) {
  if (!analysis) {
    return (
      <div className="context-tool-empty">
        <Icon>info</Icon>
        <p>No component analysis available. Upload a component to inspect detected features and dimensions.</p>
      </div>
    );
  }

  const label = resolveLabel(analysis);
  const dims = dimensionList(analysis);
  const uncertainties = Array.isArray(analysis.uncertainties) ? analysis.uncertainties : [];

  return (
    <div className="inspected-details-container fit-screen">
      {/* 1. Component Title & Metadata Header */}
      <div className="inspection-compact-header">
        <div className="inspection-title-bar">
          <div className="inspection-title-left">
            <Icon>architecture</Icon>
            <strong>{label}</strong>
          </div>
        </div>

        {/* 2-Column Meta Grid */}
        <div className="inspection-meta-pills">
          <span className="meta-pill"><strong>TYPE:</strong> {analysis.geometryType || 'Parametric Solid'}</span>
          <span className="meta-pill"><strong>MAT:</strong> {analysis.materialEstimate || 'AISI 4140'}</span>
          <span className="meta-pill"><strong>PROC:</strong> {analysis.manufacturingProcess || 'CNC Turning / Hobbing'}</span>
        </div>
      </div>

      {/* 2. Primary Inspected Dimensions & Tolerances Section */}
      <div className="inspection-dims-section">
        <div className="inspection-block-heading">
          <div className="heading-left">
            <Icon>straighten</Icon>
            <span>INSPECTED DIMENSIONS ({dims.length})</span>
          </div>
          {onToggleDims && (
            <button
              className={`dims-toggle-pill ${dimsActive ? 'active' : ''}`}
              onClick={onToggleDims}
              title={dimsActive ? "Hide 3D dimensions in viewport" : "Display 3D dimensions overlay in viewport"}
            >
              <Icon>{dimsActive ? 'visibility_off' : 'straighten'}</Icon>
              <span>{dimsActive ? '3D Active' : 'Show in 3D'}</span>
            </button>
          )}
        </div>

        <div className="inspection-dims-table" role="table" aria-label="Component Dimensions">
          {dims.length === 0 ? (
            <div className="dims-empty-state">
              <span>No dimensional parameters resolved yet.</span>
            </div>
          ) : (
            dims.map((d) => {
              const statusLower = (d.status || 'ESTIMATED').toLowerCase();
              const isMeasured = d.status === 'MEASURED';
              const isUnknown = d.status === 'UNKNOWN';
              const badgeLabel = isMeasured ? 'MEASURED' : (isUnknown ? 'UNKNOWN' : 'ESTIMATED');
              const formattedVal = formatDimValue(d.label, d.value);
              const tolerance = getDimTolerance(d.status);
              const symbol = getDimSymbol(d.label);
              const tooltip = d.reason || (isMeasured ? 'Calibrated from fiducial reference or direct OpenCV contour' : (isUnknown ? 'Unobservable / occluded in photograph' : 'Derived from mechanical invariant and module formulas'));

              return (
                <div className={`dim-table-row status-${statusLower}`} key={d.label} title={tooltip}>
                  <div className="dim-row-main">
                    <div className="dim-row-title">
                      <span className="dim-symbol">{symbol}</span>
                      <span className="dim-name">{d.label}</span>
                      {(d.key === 'outerDiameter' || d.key === 'innerDiameter') && typeof d.value === 'number' && d.value > 0 && (
                        <span className="dim-radius-hint" title={`Radius = Diameter / 2 = ${(d.value / 2).toFixed(1)} mm`}>
                          (R {(d.value / 2).toFixed(1)})
                        </span>
                      )}
                    </div>
                    <div className="dim-row-values">
                      <span className="dim-val-highlight">{formattedVal}</span>
                      <span className="dim-tol-val">{tolerance}</span>
                    </div>
                  </div>

                  <div className="dim-row-provenance">
                    <span className={`dim-status-pill status-${statusLower}`}>
                      <Icon className="tiny-icon">{isMeasured ? 'verified' : isUnknown ? 'help_outline' : 'tune'}</Icon>
                      {badgeLabel}
                    </span>
                    {d.confidence && (
                      <span className="dim-conf-sub">{Math.round(d.confidence * 100)}%</span>
                    )}
                    <span className="dim-reason-snippet">{d.reason || (isMeasured ? 'ISO 216 A4 scale' : 'Engineering constraint')}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 2B. Automatic tooth-tip count on the uploaded photograph */}
      <ToothCountOverlay analysis={analysis} images={images} compact />

      {/* 3. Detected Features: High-Density Interactive List */}
      <div className="inspection-features-block">
        <div className="inspection-block-heading">
          <div className="heading-left">
            <Icon>center_focus_strong</Icon>
            <span>DETECTED FEATURES ({features.length})</span>
          </div>
          <span className="heading-sub">Click to highlight in 3D</span>
        </div>

        <div className="features-compact-list" role="list">
          {features.length === 0 ? (
            <div className="features-empty-compact">
              <span>No individual features extracted.</span>
            </div>
          ) : (
            features.map(f => {
              const isSelected = selectedFeatureId === f.id;
              const isHovered = hoveredFeatureId === f.id && !isSelected;
              const hasGeometry = Boolean(f.geometryRef);
              const count = f.metadata?.count;
              const dia = f.metadata?.diameter;
              const teeth = f.metadata?.teeth;

              return (
                <div
                  key={f.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  className={`feature-row-compact ${isSelected ? 'selected' : ''} ${isHovered ? 'hovered' : ''}`}
                  onClick={() => onSelectFeature?.(isSelected ? null : f.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectFeature?.(isSelected ? null : f.id);
                    }
                  }}
                  onMouseEnter={() => onHoverFeature?.(f.id)}
                  onMouseLeave={() => onHoverFeature?.(null)}
                >
                  <div className="feature-row-left">
                    <span className={`feature-dot ${isSelected ? 'active' : ''}`} />
                    <span className="feature-row-label">{f.label}</span>
                    {count && count > 1 && <span className="feature-count-badge">×{count}</span>}
                    {dia != null && <span className="feature-dim-badge">Ø{dia}mm</span>}
                    {teeth != null && <span className="feature-dim-badge">{teeth}T</span>}
                  </div>

                  <div className="feature-row-right">
                    {hasGeometry ? (
                      <span className={`feature-3d-pill ${isSelected ? 'active' : ''}`}>
                        <Icon>view_in_ar</Icon> 3D
                      </span>
                    ) : (
                      <span className="feature-2d-pill">Vision</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 4. Compact Diagnostics Footer */}
      {(analysis.reasoning || uncertainties.length > 0) && (
        <div className="inspection-compact-footer">
          {analysis.reasoning && (
            <p className="inspection-reasoning-line" title={analysis.reasoning}>
              <Icon>psychology</Icon>
              <span>{analysis.reasoning}</span>
            </p>
          )}
          {uncertainties.length > 0 && (
            <div className="inspection-uncertainties-chips">
              <Icon>warning</Icon>
              {uncertainties.slice(0, 2).map((u, i) => (
                <span key={i} className="uncertainty-tag" title={u}>{u}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
export default InspectedDetailsPanel;
