import React from 'react';
import { dimensionList, resolveLabel } from '../lib/reconstruct.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function InspectedDetailsPanel({
  analysis,
  features = [],
  selectedFeatureId,
  hoveredFeatureId,
  onSelectFeature,
  onHoverFeature,
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
  const conf = typeof analysis.confidence === 'number' ? Math.round(analysis.confidence * 100) : null;

  return (
    <div className="inspected-details-container fit-screen">
      {/* 1. High-Density Specs & Dimensions Header Block */}
      <div className="inspection-compact-header">
        <div className="inspection-title-bar">
          <div className="inspection-title-left">
            <Icon>architecture</Icon>
            <strong>{label}</strong>
          </div>
          {conf != null && (
            <span className="inspection-conf-tag">{conf}% CONFIDENCE</span>
          )}
        </div>

        {/* 2-Column Meta Grid */}
        <div className="inspection-meta-pills">
          <span className="meta-pill"><strong>TYPE:</strong> {analysis.geometryType || 'Parametric Solid'}</span>
          <span className="meta-pill"><strong>MAT:</strong> {analysis.materialEstimate || 'AISI 4140'}</span>
          <span className="meta-pill"><strong>PROC:</strong> {analysis.manufacturingProcess || 'CNC Hobbing'}</span>
        </div>

        {/* Dimension Chips Row */}
        <div className="inspection-dims-chips">
          {dims.map(d => (
            <div className="dim-chip-compact" key={d.label}>
              <span className="dim-chip-k">{d.label}:</span>
              <span className="dim-chip-v">{d.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 2. Detected Features: High-Density Interactive List */}
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

      {/* 3. Compact Diagnostics Footer */}
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
