/**
 * GearHealthPanel.jsx
 * Comprehensive Gear Condition Assessment & Engineering Decision Comparison Work Window.
 *
 * Evaluates 14+ damage/wear indicators, separates evidence-supported causes from
 * further-inspection-required causes, and generates a side-by-side comparison
 * across REPLACE, REPAIR, and REDESIGN strategies.
 */

import React, { useMemo, useState } from 'react';
import { evaluateGearHealth } from '../lib/gear-health.js';
import { ComponentDropdown } from './ComponentDropdown.jsx';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">
    {children}
  </span>
);

function SeverityBadge({ severity }) {
  const sev = String(severity).toUpperCase();
  const cls = sev === 'CRITICAL' ? 'sev-critical' : sev === 'SEVERE' ? 'sev-severe' : sev === 'MODERATE' ? 'sev-moderate' : 'sev-minor';
  return <span className={`gear-health-sev-chip ${cls}`}>{sev}</span>;
}

export function GearHealthPanel({
  component,
  analysis,
  machineryState,
  activeComponentId,
  setActiveComponentId,
}) {
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'findings' | 'causes' | 'comparison'

  const healthData = useMemo(() => {
    return evaluateGearHealth(component, analysis, machineryState);
  }, [component, analysis, machineryState]);

  const {
    healthScore,
    healthStatus,
    healthSummary,
    findings,
    evidenceSupportedCauses,
    inspectionRequiredCauses,
    preferredStrategy,
    recommendationReason,
    comparison,
  } = healthData;

  const scoreClass = healthScore >= 80 ? 'score-good' : healthScore >= 55 ? 'score-fair' : healthScore >= 40 ? 'score-degraded' : 'score-critical';

  return (
    <div className="gear-health-window" aria-label="Gear Condition Assessment & Health Intelligence">
      {/* 1. Universal Component Selector Bar */}
      <ComponentDropdown
        machineryState={machineryState}
        activeComponentId={activeComponentId}
        setActiveComponentId={setActiveComponentId}
        title="GEAR HEALTH TARGET COMPONENT"
      />

      {/* 2. Top Health Overview Banner */}
      <div className={`gear-health-hero ${scoreClass}`}>
        <div className="gear-health-hero-left">
          <div className="gear-health-score-dial">
            <span className="health-score-val">{healthScore}</span>
            <span className="health-score-max">/ 100</span>
          </div>
          <div className="gear-health-hero-text">
            <div className="gear-health-status-row">
              <span className={`health-status-badge ${scoreClass}`}>
                <Icon>{healthStatus === 'CRITICAL' ? 'dangerous' : healthStatus === 'DEGRADED' ? 'warning' : 'check_circle'}</Icon>
                {healthStatus} CONDITION
              </span>
              <span className="health-gear-name">{component?.name || 'Selected Gear'}</span>
            </div>
            <p className="gear-health-summary-desc">{healthSummary}</p>
          </div>
        </div>

        <div className="gear-health-hero-stats">
          <div className="hero-stat-card">
            <span className="stat-num">{findings.length}</span>
            <span className="stat-label">DETECTED FINDINGS</span>
          </div>
          <div className="hero-stat-card">
            <span className="stat-num">{evidenceSupportedCauses.length}</span>
            <span className="stat-label">SUPPORTED CAUSES</span>
          </div>
          <div className="hero-stat-card preferred-card">
            <span className="stat-badge">{preferredStrategy}</span>
            <span className="stat-label">PREFERRED STRATEGY</span>
          </div>
        </div>
      </div>

      {/* 3. Section Navigation Tabs */}
      <div className="gear-health-nav-tabs">
        <button
          className={`health-nav-btn ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          <Icon>dashboard</Icon> FULL HEALTH AUDIT
        </button>
        <button
          className={`health-nav-btn ${activeTab === 'findings' ? 'active' : ''}`}
          onClick={() => setActiveTab('findings')}
        >
          <Icon>visibility</Icon> INSPECTION FINDINGS ({findings.length})
        </button>
        <button
          className={`health-nav-btn ${activeTab === 'causes' ? 'active' : ''}`}
          onClick={() => setActiveTab('causes')}
        >
          <Icon>account_tree</Icon> ROOT CAUSE ANALYSIS
        </button>
        <button
          className={`health-nav-btn ${activeTab === 'comparison' ? 'active' : ''}`}
          onClick={() => setActiveTab('comparison')}
        >
          <Icon>balance</Icon> DECISION COMPARISON MATRIX
        </button>
      </div>

      {/* 4. Action Recommendation Rationale Card */}
      {(activeTab === 'all' || activeTab === 'comparison') && (
        <section className="gear-recommendation-card" aria-label="Action Recommendation">
          <div className="recommendation-header">
            <div className="rec-title-group">
              <Icon className="rec-icon">verified</Icon>
              <div>
                <span className="rec-eyebrow">ENGINEERING ACTION RECOMMENDATION</span>
                <h3>STRATEGY: <span className="rec-highlight">{preferredStrategy}</span></h3>
              </div>
            </div>
            <span className="rec-target-badge">Component: {component?.name || 'Gear'}</span>
          </div>

          <div className="recommendation-body">
            <div className="rec-reason-box">
              <strong className="rec-reason-title">
                <Icon>info</Icon> WHY THIS RECOMMENDATION WAS SELECTED:
              </strong>
              <p className="rec-reason-text">{recommendationReason}</p>
            </div>
          </div>
        </section>
      )}

      {/* 5. Detailed Findings List */}
      {(activeTab === 'all' || activeTab === 'findings') && (
        <section className="gear-findings-section" aria-label="Visual & Condition Findings">
          <div className="section-head">
            <div className="section-title-wrap">
              <Icon className="section-icon">search_insights</Icon>
              <h4>ASSESSED WEAR, DEFECT &amp; DAMAGE INDICATORS</h4>
            </div>
            <span className="section-badge">{findings.length} Finding{findings.length > 1 ? 's' : ''} Documented</span>
          </div>

          <div className="findings-grid">
            {findings.map((f, idx) => (
              <div key={idx} className={`finding-card ${f.severity.toLowerCase()}`}>
                <div className="finding-top">
                  <div className="finding-issue-row">
                    <span className="finding-idx">#{idx + 1}</span>
                    <strong className="finding-issue-name">{f.issue}</strong>
                  </div>
                  <SeverityBadge severity={f.severity} />
                </div>

                <div className="finding-body">
                  <div className="finding-row">
                    <span className="finding-label">EVIDENCE:</span>
                    <p className="finding-evidence-text">{f.evidence}</p>
                  </div>

                  <div className="finding-meta-footer">
                    <div className="finding-cause-chip">
                      <Icon>psychology</Icon>
                      <span><strong>Likely Cause:</strong> {f.likelyCause}</span>
                    </div>
                    <div className="finding-conf-chip" title="Algorithm & Image Confidence">
                      <span>CONFIDENCE <strong>{f.confidence}%</strong></span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 6. Root Cause Separation (Evidence-Supported vs Inspection Required) */}
      {(activeTab === 'all' || activeTab === 'causes') && (
        <section className="gear-causes-section" aria-label="Root Cause Breakdown">
          <div className="section-head">
            <div className="section-title-wrap">
              <Icon className="section-icon">mediation</Icon>
              <h4>ROOT CAUSE TAXONOMY &amp; FAILURE MECHANISMS</h4>
            </div>
            <span className="section-badge">Separated by Evidence Verification</span>
          </div>

          <div className="causes-dual-column">
            {/* Column A: Evidence-Supported Causes */}
            <div className="cause-column evidence-supported-col">
              <div className="col-header">
                <Icon className="col-icon supported">check_circle</Icon>
                <div>
                  <h5>EVIDENCE-SUPPORTED CAUSES</h5>
                  <span className="col-subtitle">Direct visual, geometric or stress corroboration</span>
                </div>
              </div>

              <div className="cause-list">
                {evidenceSupportedCauses.length === 0 ? (
                  <p className="cause-empty">No conclusive direct evidence detected.</p>
                ) : (
                  evidenceSupportedCauses.map((c, i) => (
                    <div key={i} className="cause-item-card supported">
                      <div className="cause-item-head">
                        <strong className="cause-name">{c.cause}</strong>
                        <span className="cause-count-badge">{c.count} finding{c.count > 1 ? 's' : ''}</span>
                      </div>
                      <ul className="cause-evidence-bullets">
                        {c.evidenceList.map((ev, j) => (
                          <li key={j}>{ev}</li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Column B: Causes Requiring Further Inspection */}
            <div className="cause-column inspection-required-col">
              <div className="col-header">
                <Icon className="col-icon pending">pending_actions</Icon>
                <div>
                  <h5>POSSIBLE CAUSES REQUIRING FURTHER INSPECTION</h5>
                  <span className="col-subtitle">Hypotheses to confirm via NDT, oil lab, or CMM metrology</span>
                </div>
              </div>

              <div className="cause-list">
                {inspectionRequiredCauses.length === 0 ? (
                  <p className="cause-empty">No secondary inspection flags raised.</p>
                ) : (
                  inspectionRequiredCauses.map((c, i) => (
                    <div key={i} className="cause-item-card pending">
                      <div className="cause-item-head">
                        <strong className="cause-name">{c.cause}</strong>
                        <span className="cause-issue-tag">For: {c.relatedIssue}</span>
                      </div>
                      <div className="cause-rationale-box">
                        <Icon>biotech</Icon>
                        <p>{c.rationale}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 7. Side-by-Side Strategy Comparison Matrix */}
      {(activeTab === 'all' || activeTab === 'comparison') && (
        <section className="gear-comparison-section" aria-label="Strategy Comparison Matrix">
          <div className="section-head">
            <div className="section-title-wrap">
              <Icon className="section-icon">compare_arrows</Icon>
              <h4>SIDE-BY-SIDE STRATEGY COMPARISON: REPLACE vs REPAIR vs REDESIGN</h4>
            </div>
            <span className="section-badge">Multi-Criteria Decision Matrix</span>
          </div>

          <div className="comparison-cards-grid">
            {comparison.map((opt) => (
              <div
                key={opt.strategy}
                className={`comparison-card ${opt.strategy.toLowerCase()} ${opt.isPreferred ? 'is-preferred' : ''}`}
              >
                <div className="comp-card-header">
                  {opt.isPreferred && (
                    <div className="preferred-pill-banner">
                      <Icon>star</Icon> PREFERRED RECOMMENDATION
                    </div>
                  )}
                  <span className="strategy-tag">{opt.strategy}</span>
                  <h4 className="strategy-title">{opt.title}</h4>
                  <p className="strategy-desc">{opt.description}</p>
                </div>

                <div className="comp-card-metrics">
                  <div className="metric-row">
                    <span className="metric-label">INITIAL COST:</span>
                    <strong className="metric-value cost">{opt.initialCostFormatted}</strong>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label">LEAD TIME:</span>
                    <strong className="metric-value">{opt.leadTime}</strong>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label">EXPECTED LONGEVITY:</span>
                    <strong className="metric-value">{opt.expectedLongevity}</strong>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label">FAILURE RISK:</span>
                    <span className={`risk-badge risk-${opt.failureRiskLevel}`}>
                      {opt.failureRisk}
                    </span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label">EST. 5-YR TOTAL COST:</span>
                    <strong className="metric-value tco">{opt.longTermCost5YrFormatted}</strong>
                  </div>
                </div>

                <div className="comp-card-details">
                  <div className="detail-box">
                    <span className="detail-head"><Icon>build</Icon> MAINTENANCE:</span>
                    <p>{opt.maintenance}</p>
                  </div>
                  <div className="detail-box">
                    <span className="detail-head"><Icon>inventory_2</Icon> AVAILABILITY:</span>
                    <p>{opt.availability}</p>
                  </div>
                  <div className="detail-box">
                    <span className="detail-head"><Icon>precision_manufacturing</Icon> MFG COMPLEXITY:</span>
                    <p>{opt.manufacturingComplexity}</p>
                  </div>
                </div>

                <div className="comp-card-proscons">
                  <div className="pros-block">
                    <span className="pros-head"><Icon>thumb_up</Icon> ADVANTAGES:</span>
                    <ul>
                      {opt.pros.map((p, idx) => (
                        <li key={idx}>{p}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="cons-block">
                    <span className="cons-head"><Icon>thumb_down</Icon> TRADE-OFFS:</span>
                    <ul>
                      {opt.cons.map((c, idx) => (
                        <li key={idx}>{c}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default GearHealthPanel;
