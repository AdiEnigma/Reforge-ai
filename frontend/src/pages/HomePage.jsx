import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Icon } from '../components/Icon.jsx';

export function HomePage() {
  const { user, organization, role, logout } = useAuth();
  const [activeModal, setActiveModal] = useState(null); // 'standard-part' | 'manufacturing-cost' | null

  // Since backend persistence for projects, parts, estimates, and catalog matches is planned for subsequent phases,
  // we query or represent real state. Empty arrays denote 0 actual persisted records.
  const stats = [
    {
      id: 'parts',
      label: 'My Parts',
      value: 0,
      subtext: 'Saved components',
      icon: 'precision_manufacturing',
    },
    {
      id: 'projects',
      label: 'Active Projects',
      value: 0,
      subtext: 'Engineering work orders',
      icon: 'folder_open',
    },
    {
      id: 'estimates',
      label: 'Manufacturing Estimates',
      value: 0,
      subtext: 'Completed cost models',
      icon: 'calculate',
    },
    {
      id: 'matches',
      label: 'Standard Part Matches',
      value: 0,
      subtext: 'Catalogue identifications',
      icon: 'search_check',
    },
  ];

  const quickActions = [
    {
      id: 'reconstruct',
      title: 'Reconstruct a Component',
      description: 'Upload component photos to generate an engineering CAD model, 2D drawings, and inspection profile.',
      icon: 'view_in_ar',
      tag: 'CORE PIPELINE',
      actionType: 'link',
      to: '/app/new?view=upload',
      ctaText: 'Start Reconstruction',
      primary: true,
    },
    {
      id: 'standard-part',
      title: 'Identify a Standard Part',
      description: 'Match existing industrial components against standard catalogues using vision and dimensions before rebuilding.',
      icon: 'document_scanner',
      tag: 'CATALOGUE MATCHER',
      actionType: 'modal',
      modalKey: 'standard-part',
      ctaText: 'Explore Matcher',
      primary: false,
    },
    {
      id: 'estimate',
      title: 'Estimate Manufacturing Cost',
      description: 'Evaluate machining, casting, forging, batch operations, cycle times, and raw material expenditures.',
      icon: 'calculate',
      tag: 'COST ENGINE',
      actionType: 'modal',
      modalKey: 'manufacturing-cost',
      ctaText: 'View Estimator',
      primary: false,
    },
    {
      id: 'library',
      title: 'Engineering Library',
      description: 'Access organization archives, saved STEP/DXF exports, versioned recipes, and technical documentation.',
      icon: 'inventory_2',
      tag: 'ARCHIVES',
      actionType: 'link',
      to: '/library',
      ctaText: 'Open Library',
      primary: false,
    },
  ];

  return (
    <div className="home-dashboard-layout">
      {/* Top Navigation */}
      <header className="home-header">
        <div className="brand-group">
          <Link to="/home" className="home-brand-link">
            <span className="brand-title">ReForge AI</span>
          </Link>
          <span className="cad-readout-pill">SYS: INDUSTRIAL GATEWAY</span>
          <div className="workspace-badge-group">
            <span className="workspace-dot" />
            <span className="workspace-name">{organization?.name || 'MSME Workspace'}</span>
          </div>
        </div>

        <div className="user-profile-widget">
          <div className="user-meta">
            <span className="user-name">{user?.displayName || 'Lead Engineer'}</span>
            <span className="org-badge">
              {organization?.name || 'Workspace'} &bull; <span className="pill-role">{role || 'viewer'}</span>
            </span>
          </div>
          <button className="secondary icon-only logout-btn" onClick={logout} title="Sign Out" aria-label="Sign Out">
            <Icon>logout</Icon>
          </button>
        </div>
      </header>

      {/* Main Surface */}
      <main className="home-content">
        {/* Welcome Section */}
        <section className="welcome-banner">
          <div className="welcome-header-row">
            <div>
              <p className="eyebrow">MSME ENGINEERING DASHBOARD // {organization?.name?.toUpperCase() || 'WORKSPACE'}</p>
              <h1>Welcome, {user?.displayName || 'Engineer'}</h1>
              <p className="subtitle">
                Your engineering workspace for component identification, reverse engineering, CAD reconstruction and manufacturing intelligence.
              </p>
            </div>
            <div className="welcome-actions">
              <Link to="/app/new?view=upload" className="primary welcome-btn primary-btn">
                <Icon>add</Icon> Start New Project
              </Link>
              <button
                type="button"
                className="secondary welcome-btn secondary-btn"
                onClick={() => setActiveModal('standard-part')}
              >
                <Icon>document_scanner</Icon> Identify Standard Part
              </button>
            </div>
          </div>
        </section>

        {/* Overview Statistics Cards */}
        <section className="stats-section" aria-label="Organization Overview Statistics">
          <div className="stats-grid">
            {stats.map((s) => (
              <div key={s.id} className="stat-card">
                <div className="stat-card-header">
                  <span className="stat-label">{s.label}</span>
                  <div className="stat-icon-wrap">
                    <Icon>{s.icon}</Icon>
                  </div>
                </div>
                <div className="stat-value">{s.value}</div>
                <div className="stat-subtext">{s.subtext}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Quick Actions Section */}
        <section className="quick-actions-section">
          <div className="section-header">
            <h2 className="section-title">What would you like to do?</h2>
            <p className="section-subtitle">Select an engineering capability or jump directly into active pipelines.</p>
          </div>

          <div className="quick-actions-grid">
            {quickActions.map((action) => (
              <div key={action.id} className={`action-card ${action.primary ? 'action-card-primary' : ''}`}>
                <div className="action-card-top">
                  <span className="card-tag">{action.tag}</span>
                  <div className="action-icon-wrap">
                    <Icon>{action.icon}</Icon>
                  </div>
                </div>
                <h3>{action.title}</h3>
                <p>{action.description}</p>
                <div className="action-card-footer">
                  {action.actionType === 'link' ? (
                    <Link
                      to={action.to}
                      className={action.primary ? 'primary action-btn' : 'secondary action-btn'}
                    >
                      {action.ctaText} <Icon>arrow_forward</Icon>
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="secondary action-btn"
                      onClick={() => setActiveModal(action.modalKey)}
                    >
                      {action.ctaText} <Icon>open_in_new</Icon>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Two-Column Area: Recent Projects & Activity + Org Profile */}
        <div className="dashboard-columns-grid">
          {/* Left Column: Projects & Recent Activity */}
          <div className="main-column">
            {/* Recent Projects Section */}
            <section className="dashboard-section-block">
              <div className="section-header-compact">
                <div className="section-title-wrap">
                  <Icon>folder</Icon>
                  <h3>Recent Projects</h3>
                </div>
                <Link to="/app/new?view=upload" className="inline-action-link">
                  <Icon>add</Icon> New Project
                </Link>
              </div>

              <div className="panel-box empty-state-box">
                <div className="empty-icon-wrap">
                  <Icon>draft</Icon>
                </div>
                <h4>No engineering projects yet</h4>
                <p>Start by uploading component photographs to synthesize your first parametric CAD reconstruction.</p>
                <Link to="/app/new?view=upload" className="primary empty-state-btn">
                  <Icon>upload</Icon> Start First Reconstruction
                </Link>
              </div>
            </section>

            {/* Recent Activity Section */}
            <section className="dashboard-section-block">
              <div className="section-header-compact">
                <div className="section-title-wrap">
                  <Icon>history</Icon>
                  <h3>Recent Activity</h3>
                </div>
              </div>

              <div className="panel-box empty-state-box">
                <div className="empty-icon-wrap">
                  <Icon>timeline</Icon>
                </div>
                <h4>No activity logged yet</h4>
                <p>Actions such as component inspection, CAD synthesis, and cost estimations will be recorded here.</p>
              </div>
            </section>
          </div>

          {/* Right Column: Organization Profile & Shop Credentials */}
          <aside className="side-column">
            <section className="dashboard-section-block">
              <div className="section-header-compact">
                <div className="section-title-wrap">
                  <Icon>business</Icon>
                  <h3>Organization Profile</h3>
                </div>
              </div>

              <div className="dashboard-card org-profile-card">
                <div className="org-profile-header">
                  <div className="org-avatar">
                    <Icon>factory</Icon>
                  </div>
                  <div>
                    <h4 className="org-name-text">{organization?.name || 'Industrial Facility'}</h4>
                    <span className="org-slug-text">REF // {organization?.slug || 'msme-shop'}</span>
                  </div>
                </div>

                <div className="org-details-list">
                  <div className="profile-detail-row">
                    <span className="detail-label">Active Member:</span>
                    <span className="detail-value">{user?.displayName || 'Engineer'}</span>
                  </div>
                  <div className="profile-detail-row">
                    <span className="detail-label">Work Email:</span>
                    <span className="detail-value mono-text">{user?.email || 'N/A'}</span>
                  </div>
                  <div className="profile-detail-row">
                    <span className="detail-label">Shop Role:</span>
                    <span className="detail-value pill-role">{role || 'viewer'}</span>
                  </div>
                  <div className="profile-detail-row">
                    <span className="detail-label">Workspace Status:</span>
                    <span className="detail-value status-online">
                      <span className="status-indicator-dot" /> ACTIVE TENANT
                    </span>
                  </div>
                </div>

                <div className="org-profile-footer">
                  <div className="security-notice">
                    <Icon>lock</Icon>
                    <span>Session secured via HttpOnly cookie &amp; CSRF protection.</span>
                  </div>
                </div>
              </div>
            </section>

            {/* Upcoming Feature Notice / Standard Parts Preview */}
            <section className="dashboard-section-block">
              <div className="standard-part-teaser-card">
                <div className="teaser-tag">UPCOMING CAPABILITY</div>
                <h4>Standard Part Matcher</h4>
                <p>
                  Identify standard industrial components from catalogues before spending time reconstructing them from scratch.
                </p>
                <button
                  type="button"
                  className="secondary text-btn"
                  onClick={() => setActiveModal('standard-part')}
                >
                  Learn how it works <Icon>arrow_forward</Icon>
                </button>
              </div>
            </section>
          </aside>
        </div>
      </main>

      {/* Modal: Standard Part Identification Overview */}
      {activeModal === 'standard-part' && (
        <div className="modal-backdrop" onClick={() => setActiveModal(null)} role="dialog" aria-modal="true">
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-group">
                <span className="eyebrow">UPCOMING CAPABILITY</span>
                <h3>Standard Part Identification</h3>
              </div>
              <button
                type="button"
                className="close-btn icon-only"
                onClick={() => setActiveModal(null)}
                aria-label="Close dialog"
              >
                <Icon>close</Icon>
              </button>
            </div>

            <div className="modal-body">
              <p className="modal-lead">
                Identify an existing standard component before spending engineering hours reconstructing it.
              </p>

              <div className="workflow-steps-list">
                <div className="step-item">
                  <span className="step-number">01</span>
                  <div>
                    <strong>Upload photographs</strong>
                    <p>Capture views of the part with scale or reference markings.</p>
                  </div>
                </div>
                <div className="step-item">
                  <span className="step-number">02</span>
                  <div>
                    <strong>Provide critical dimensions</strong>
                    <p>Enter bore diameter, outer diameter, tooth count, or pitch.</p>
                  </div>
                </div>
                <div className="step-item">
                  <span className="step-number">03</span>
                  <div>
                    <strong>Catalogue specification matching</strong>
                    <p>Cross-reference against ISO, DIN, ANSI, and Indian Standard (IS) manufacturer catalogues.</p>
                  </div>
                </div>
                <div className="step-item">
                  <span className="step-number">04</span>
                  <div>
                    <strong>Procure vs Re-manufacture decision</strong>
                    <p>Compare standard supplier lead times and pricing against local CNC/forging fabrication.</p>
                  </div>
                </div>
              </div>

              <div className="callout-box">
                <Icon>info</Icon>
                <span>The catalogue matching engine is currently in engineering validation. For now, use the reconstruction pipeline to synthesize custom models.</span>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="secondary" onClick={() => setActiveModal(null)}>
                Close
              </button>
              <Link
                to="/app/new?view=upload"
                className="primary modal-action-btn"
                onClick={() => setActiveModal(null)}
              >
                <Icon>view_in_ar</Icon> Reconstruct Instead
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Manufacturing Cost Estimator Entry */}
      {activeModal === 'manufacturing-cost' && (
        <div className="modal-backdrop" onClick={() => setActiveModal(null)} role="dialog" aria-modal="true">
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-group">
                <span className="eyebrow">INTELLIGENCE SUITE</span>
                <h3>Manufacturing Cost Estimator</h3>
              </div>
              <button
                type="button"
                className="close-btn icon-only"
                onClick={() => setActiveModal(null)}
                aria-label="Close dialog"
              >
                <Icon>close</Icon>
              </button>
            </div>

            <div className="modal-body">
              <p className="modal-lead">
                Manufacturing intelligence is integrated directly into the component analysis and 3D workbench pipeline.
              </p>
              <p style={{ color: 'var(--muted)', fontSize: '13px', lineHeight: 1.6 }}>
                Once you reconstruct a component, the manufacturing configurator calculates:
              </p>
              <ul style={{ color: 'var(--text)', fontSize: '13px', lineHeight: 1.8, paddingLeft: '20px' }}>
                <li>Raw stock material cost (Mild Steel, Stainless, Brass, Aluminum, Tool Steel)</li>
                <li>Primary operations (CNC Turning, 3-Axis / 5-Axis Milling, Wire EDM, Gear Hobbing)</li>
                <li>Batch quantity amortization &amp; setup fee breakdown</li>
                <li>Tolerance &amp; surface finish cost multipliers (DIN 6 vs DIN 9)</li>
                <li>Material alternative comparisons with instant INR ₹ deltas</li>
              </ul>
            </div>

            <div className="modal-footer">
              <button type="button" className="secondary" onClick={() => setActiveModal(null)}>
                Close
              </button>
              <Link
                to="/app/new?view=upload"
                className="primary modal-action-btn"
                onClick={() => setActiveModal(null)}
              >
                <Icon>arrow_forward</Icon> Upload Component to Estimate
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
