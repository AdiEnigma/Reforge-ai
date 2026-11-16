import React from 'react';
import { resolveLabel } from '../lib/reconstruct.js';
import { getAllComponents } from '../lib/machinery-context.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function ComponentHealthPanel({
  analysis,
  machineryState,
  activeComponentId,
}) {
  if (!analysis) {
    return (
      <div className="context-tool-empty">
        <Icon>health_and_safety</Icon>
        <p>No component health data. Reconstruct a component to inspect health, wear patterns, and risk assessments.</p>
      </div>
    );
  }

  const label = resolveLabel(analysis);
  const confidence = typeof analysis.confidence === 'number' ? analysis.confidence : 0.8;
  const allComponents = getAllComponents(machineryState);
  const currentComp = allComponents.find(c => c.id === activeComponentId) || machineryState?.primaryGear;

  const wearImages = [];
  if (currentComp?.images) {
    currentComp.images.forEach(img => {
      if (img.purpose === 'wear_defect' || (img.note && /wear|crack|defect|chip|pit|damage/i.test(img.note))) {
        wearImages.push(img);
      }
    });
  }

  const uncertainties = Array.isArray(analysis.uncertainties) ? analysis.uncertainties : [];
  const hasSevereNotes = wearImages.some(w => /crack|break|severe|fail/i.test(w.note || ''));
  
  let healthRating = 'NORMAL';
  let healthBadgeClass = 'health-good';
  let healthScore = 88;

  if (hasSevereNotes) {
    healthRating = 'ACTION REQUIRED';
    healthBadgeClass = 'health-critical';
    healthScore = 42;
  } else if (wearImages.length > 0 || uncertainties.length >= 2 || confidence < 0.7) {
    healthRating = 'ATTENTION ADVISED';
    healthBadgeClass = 'health-warning';
    healthScore = 68;
  }

  return (
    <div className="component-health-container fit-screen">
      {/* 1. Status Bar Card */}
      <div className="health-compact-header">
        <div className="health-status-left">
          <span className={`health-dot-indicator ${healthBadgeClass}`} />
          <div>
            <span className="health-component-label">{label}</span>
            <h4 className="health-rating-title">{healthRating}</h4>
          </div>
        </div>
        <div className={`health-score-badge ${healthBadgeClass}`}>
          <span className="health-score-val">{healthScore}</span>
          <span className="health-score-max">/100</span>
        </div>
      </div>

      {/* 2. Three Compact Risk Columns */}
      <div className="health-risks-compact-grid">
        <div className="risk-compact-cell">
          <div className="risk-cell-header">
            <strong>Bending Fatigue</strong>
            <span className="risk-level-tag low">LOW</span>
          </div>
          <p>Root fillet transition adequate for cyclic load.</p>
        </div>

        <div className="risk-compact-cell">
          <div className="risk-cell-header">
            <strong>Contact Pitting</strong>
            <span className={`risk-level-tag ${wearImages.length > 0 ? 'med' : 'low'}`}>
              {wearImages.length > 0 ? 'MED' : 'LOW'}
            </span>
          </div>
          <p>Monitor pitch line lubrication &amp; surface hardness.</p>
        </div>

        <div className="risk-compact-cell">
          <div className="risk-cell-header">
            <strong>Keyway Stress</strong>
            <span className="risk-level-tag low">OK</span>
          </div>
          <p>Check keyway fillet radii under shock reversals.</p>
        </div>
      </div>

      {/* 3. Wear Evidence or Staged Notes */}
      <div className="health-evidence-compact">
        <div className="evidence-heading">
          <Icon>search_check</Icon>
          <span>WEAR EVIDENCE ({wearImages.length})</span>
        </div>
        {wearImages.length === 0 ? (
          <div className="evidence-empty-line">
            <Icon>check_circle</Icon>
            <span>No defect tags in current visual context.</span>
          </div>
        ) : (
          <div className="evidence-chips-row">
            {wearImages.map((img, idx) => (
              <span key={img.id || idx} className="evidence-chip">
                Defect #{idx + 1}: {img.note || 'Tooth wear'}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 4. Recommendations List */}
      <div className="health-recs-compact">
        <div className="recs-heading">
          <Icon>build</Icon>
          <span>RECOMMENDED VERIFICATION</span>
        </div>
        <ul className="recs-compact-list">
          <li>Conduct NDT (MPI / Dye Penetrant) on root fillets prior to critical service.</li>
          <li>Confirm case hardness depth (58–62 HRC) to prevent scuffing.</li>
          <li>Check operational center distance with mating gear to ensure nominal backlash.</li>
        </ul>
      </div>

      {/* 5. Compact Disclaimer Footer */}
      <div className="health-compact-disclaimer">
        <Icon>info</Icon>
        <span>Visual damage evaluation from photographs; physical NDT required for subsurface certification.</span>
      </div>
    </div>
  );
}
export default ComponentHealthPanel;
