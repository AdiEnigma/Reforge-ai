import React from 'react';
import { resolveLabel } from '../lib/reconstruct.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

const SURFACE_KEYWORDS = [
  'corrosion', 'rust', 'pitting', 'deterioration', 'scoring',
  'discoloration', 'contamination', 'roughness',
];
const TOOTH_KEYWORDS = ['tooth wear', 'chipping', 'deformation'];

function tagMatches(tag, keywords) {
  const lower = String(tag).toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

function isSevere(tag) {
  return String(tag).toLowerCase().startsWith('severe');
}

export function ComponentHealthPanel({ analysis }) {
  if (!analysis) {
    return (
      <div className="context-tool-empty">
        <Icon>health_and_safety</Icon>
        <p>No component health data. Reconstruct a component to inspect health, wear patterns, and risk assessments.</p>
      </div>
    );
  }

  const label = resolveLabel(analysis);
  const assessment =
    analysis.conditionAssessment && typeof analysis.conditionAssessment === 'object'
      ? analysis.conditionAssessment
      : null;

  const status = assessment?.status || 'NEEDS INSPECTION';
  const score =
    assessment && typeof assessment.healthScore === 'number'
      ? assessment.healthScore
      : null;
  const badgeClass =
    status === 'NORMAL'
      ? 'health-good'
      : status === 'ACTION REQUIRED'
        ? 'health-critical'
        : 'health-warning';

  const observedDefects = Array.isArray(assessment?.observedDefects)
    ? assessment.observedDefects.filter((tag) => typeof tag === 'string')
    : [];
  const wearEvidenceCount =
    assessment && typeof assessment.wearEvidenceCount === 'number'
      ? assessment.wearEvidenceCount
      : observedDefects.length;
  const suspectedInternal = Array.isArray(assessment?.suspectedInternal)
    ? assessment.suspectedInternal.filter((item) => typeof item === 'string')
    : [];
  const recommendations = Array.isArray(assessment?.recommendedVerification)
    ? assessment.recommendedVerification.filter((item) => typeof item === 'string')
    : [];
  const summary = assessment?.summary || '';
  const imageQuality = assessment?.imageQuality || 'insufficient';

  const surfaceTags = observedDefects.filter((tag) => tagMatches(tag, SURFACE_KEYWORDS));
  const toothTags = observedDefects.filter((tag) => tagMatches(tag, TOOTH_KEYWORDS));
  const visibleCrack = observedDefects.some((tag) => tag.toLowerCase().includes('crack'));

  const surfaceLevel = surfaceTags.some(isSevere)
    ? { text: 'SEVERE', cls: 'high' }
    : surfaceTags.length > 0
      ? { text: 'DEGRADED', cls: 'med' }
      : status === 'NORMAL'
        ? { text: 'OK', cls: 'low' }
        : { text: 'NOT ASSESSED', cls: 'low' };

  const toothLevel = toothTags.some(isSevere)
    ? { text: 'COMPROMISED', cls: 'high' }
    : toothTags.length > 0
      ? { text: 'MONITOR', cls: 'med' }
      : { text: 'NO VISIBLE DAMAGE', cls: 'low' };

  const internalLevel = visibleCrack
    ? { text: 'VISIBLE INDICATION', cls: 'high' }
    : suspectedInternal.length > 0
      ? { text: 'UNCONFIRMED', cls: 'med' }
      : { text: 'NOT ASSESSED', cls: 'low' };

  const evidenceMessage = !assessment
    ? 'No visual condition assessment is attached to this analysis.'
    : observedDefects.length === 0 && status === 'NEEDS INSPECTION'
      ? 'No confirmed defects; image evidence is insufficient for a reliable score.'
      : observedDefects.length === 0
        ? 'No visible defects were identified in the supplied photographs.'
        : '';

  return (
    <div className="component-health-container fit-screen">
      {/* 1. Status Bar Card */}
      <div className="health-compact-header">
        <div className="health-status-left">
          <span className={`health-dot-indicator ${badgeClass}`} />
          <div>
            <span className="health-component-label">{label}</span>
            <h4 className="health-rating-title">{status}</h4>
          </div>
        </div>
        <div className={`health-score-badge ${badgeClass}`}>
          <span className="health-score-val">{score == null ? '—' : score}</span>
          {score != null && <span className="health-score-max">/100</span>}
        </div>
      </div>

      {summary && (
        <p style={{ margin: '8px 0', fontSize: 10, color: 'var(--muted)' }}>{summary}</p>
      )}
      {imageQuality === 'limited' && (
        <p style={{ margin: '0 0 8px', fontSize: 10, color: 'var(--gold)' }}>
          Limited image quality — score reflects only clearly visible evidence.
        </p>
      )}

      {/* 2. Three Compact Risk Columns — all grounded in visible evidence */}
      <div className="health-risks-compact-grid">
        <div className="risk-compact-cell">
          <div className="risk-cell-header">
            <strong>Surface Condition</strong>
            <span className={`risk-level-tag ${surfaceLevel.cls}`}>{surfaceLevel.text}</span>
          </div>
          <p>
            {surfaceTags.length > 0
              ? 'Visible oxidation, pitting or surface deterioration reported from photographs.'
              : status === 'NORMAL'
                ? 'No visible surface deterioration identified.'
                : 'Surface condition could not be confirmed from the available images.'}
          </p>
        </div>

        <div className="risk-compact-cell">
          <div className="risk-cell-header">
            <strong>Tooth / Edge Integrity</strong>
            <span className={`risk-level-tag ${toothLevel.cls}`}>{toothLevel.text}</span>
          </div>
          <p>
            {toothTags.length > 0
              ? 'Wear, chipping or deformation reported on teeth or edges.'
              : 'No visible tooth or edge damage reported.'}
          </p>
        </div>

        <div className="risk-compact-cell">
          <div className="risk-cell-header">
            <strong>Internal / Subsurface</strong>
            <span className={`risk-level-tag ${internalLevel.cls}`}>{internalLevel.text}</span>
          </div>
          <p>
            {visibleCrack
              ? 'A visible crack indication was reported; verify with NDT before service.'
              : suspectedInternal.length > 0
                ? 'Concerns listed below are not confirmed by photographs; NDT is required.'
                : 'Photographs cannot confirm fatigue or subsurface cracking.'}
          </p>
        </div>
      </div>

      {/* 3. Wear Evidence from image-based assessment */}
      <div className="health-evidence-compact">
        <div className="evidence-heading">
          <Icon>search_check</Icon>
          <span>WEAR EVIDENCE ({wearEvidenceCount})</span>
        </div>
        {evidenceMessage && (
          <div className="evidence-empty-line">
            <Icon>info</Icon>
            <span>{evidenceMessage}</span>
          </div>
        )}
        {observedDefects.length > 0 && (
          <div className="evidence-chips-row">
            {observedDefects.map((tag, idx) => (
              <span key={`${tag}-${idx}`} className="evidence-chip">
                Defect #{idx + 1}: {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 4. Suspected internal issues — explicitly separated from observations */}
      {suspectedInternal.length > 0 && (
        <div className="health-evidence-compact" style={{ marginTop: 8 }}>
          <div className="evidence-heading">
            <Icon>help_outline</Icon>
            <span>SUSPECTED — NOT VISUALLY CONFIRMED</span>
          </div>
          <ul className="recs-compact-list">
            {suspectedInternal.map((item, idx) => (
              <li key={`${item}-${idx}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 5. Recommendations List */}
      <div className="health-recs-compact">
        <div className="recs-heading">
          <Icon>build</Icon>
          <span>RECOMMENDED VERIFICATION</span>
        </div>
        <ul className="recs-compact-list">
          {(recommendations.length > 0
            ? recommendations
            : ['Manual visual inspection required; no automated assessment available.']
          ).map((item, idx) => (
            <li key={`${item}-${idx}`}>{item}</li>
          ))}
        </ul>
      </div>

      {/* 6. Compact Disclaimer Footer */}
      <div className="health-compact-disclaimer">
        <Icon>info</Icon>
        <span>Visual damage evaluation from photographs; physical NDT required for subsurface certification.</span>
      </div>
    </div>
  );
}

export default ComponentHealthPanel;
