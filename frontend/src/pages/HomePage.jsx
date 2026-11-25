import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { listWorkbenchesApi, updateWorkbenchApi, deleteWorkbenchApi } from '../lib/workbench-api.js';

function formatTimestamp(ts) {
  if (!ts) return 'Unknown';
  try {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

export function HomePage({ onNavigate, onResumeWorkbench, onStartNewReconstruction }) {
  const { user, organization, role } = useAuth();
  const [workbenches, setWorkbenches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameText, setRenameText] = useState('');

  const loadWorkbenches = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const list = await listWorkbenchesApi();
      setWorkbenches(list);
    } catch (err) {
      setError(err.message || 'Failed to load recent workbenches.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkbenches();
  }, [loadWorkbenches]);

  const handleStartReconstruction = () => {
    if (onStartNewReconstruction) {
      onStartNewReconstruction();
    } else if (onNavigate) {
      onNavigate('upload');
    }
  };

  const handleGoWorkbench = () => {
    if (onNavigate) {
      onNavigate('workbench');
    }
  };

  const handleResume = (id) => {
    if (onResumeWorkbench) {
      onResumeWorkbench(id);
    } else if (onNavigate) {
      onNavigate('workbench');
    }
  };

  const handleStartRename = (e, wb) => {
    e.stopPropagation();
    setRenamingId(wb.id);
    setRenameText(wb.name || '');
  };

  const handleSaveRename = async (e, id) => {
    e.stopPropagation();
    if (!renameText.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await updateWorkbenchApi(id, { name: renameText.trim() });
      setRenamingId(null);
      loadWorkbenches();
    } catch (err) {
      alert(err.message || 'Failed to rename workbench.');
    }
  };

  const handleDelete = async (e, id, name) => {
    e.stopPropagation();
    const confirmed = window.confirm(`Permanently delete "${name || 'Workbench'}" and all its saved assets?`);
    if (!confirmed) return;
    try {
      await deleteWorkbenchApi(id);
      loadWorkbenches();
    } catch (err) {
      alert(err.message || 'Failed to delete workbench.');
    }
  };

  const isAdmin = role === 'admin';
  const orgTitle = organization?.name || 'Indus Valley';
  const username = user?.username || (isAdmin ? 'admin-001' : 'user-01');
  const displayName = user?.displayName || (isAdmin ? 'Indus Valley Admin' : 'Shop Engineer');
  const email = user?.email || `${username}@reforge.local`;

  return (
    <div className="homepage-wrapper">
      <main className="homepage-main">
        {/* B. Welcome Panel */}
        <section className="dashboard-welcome-panel">
          <div className="cad readout top-right">SYS: ONLINE // REV-ENG: ACTIVE</div>
          <div className="welcome-tag">
            {isAdmin ? `ORGANIZATION WORKSPACE // ${orgTitle.toUpperCase()}` : 'PERSONAL WORKSPACE // INDIVIDUAL USER'}
          </div>

          <h1 className="welcome-title">
            WELCOME, <span>{username.toUpperCase()}</span>
          </h1>

          <p className="welcome-subtitle">
            Your engineering workspace for component reconstruction and manufacturing intelligence.
          </p>

          <div className="welcome-actions">
            <button
              type="button"
              className="primary welcome-primary-btn"
              onClick={handleStartReconstruction}
            >
              START NEW RECONSTRUCTION →
            </button>
            <button
              type="button"
              className="secondary welcome-secondary-btn"
              onClick={handleGoWorkbench}
            >
              Open Active Workbench
            </button>
          </div>
        </section>

        {/* C. Quick Access Section */}
        <section className="dashboard-section">
          <div className="section-label-row">
            <span className="section-eyebrow">QUICK ACCESS // WORKFLOW</span>
          </div>

          <div className="quick-access-grid">
            <div className="quick-card" onClick={handleStartReconstruction} role="button" tabIndex={0}>
              <div className="quick-card-icon">⚙️</div>
              <div className="quick-card-body">
                <h3>Start New Reconstruction</h3>
                <p>Upload photos of gears, shafts, or mechanical parts to begin parametric 3D synthesis.</p>
              </div>
              <span className="quick-card-arrow">→</span>
            </div>

            <div className="quick-card" onClick={handleGoWorkbench} role="button" tabIndex={0}>
              <div className="quick-card-icon">📐</div>
              <div className="quick-card-body">
                <h3>Return to Engineering Workbench</h3>
                <p>Inspect 3D viewport, review manufacturing intelligence, and export B-Rep CAD models.</p>
              </div>
              <span className="quick-card-arrow">→</span>
            </div>
          </div>
        </section>

        {/* C2. Recent Workbenches Section (Directly Below Quick Access) */}
        <section className="dashboard-section recent-workbenches-section">
          <div className="section-header-block">
            <div className="section-title-row">
              <h2 className="section-main-heading">RECENT WORKBENCHES</h2>
              <span className="section-header-pill">LOCAL PERSISTENCE // ACTIVE</span>
            </div>
            <p className="section-supporting-text">
              Continue your previous engineering sessions or revisit completed reconstructions.
            </p>
          </div>

          {error && (
            <div className="wb-error-card">
              <div className="wb-error-content">
                <span className="wb-error-icon">⚠️</span>
                <div>
                  <h4 className="wb-error-title">UNABLE TO LOAD WORKBENCHES</h4>
                  <p className="wb-error-desc">{error}</p>
                </div>
              </div>
              <button
                type="button"
                className="secondary wb-retry-btn"
                onClick={loadWorkbenches}
              >
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div className="auth-splash" style={{ minHeight: '160px', padding: '20px' }}>
              <div className="auth-spinner" />
              <p style={{ marginTop: '12px', fontSize: '12px', color: 'var(--muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                LOADING RECENT WORKBENCHES...
              </p>
            </div>
          ) : error ? null : workbenches.length === 0 ? (
            /* Empty State */
            <div className="wb-empty-state">
              <div className="wb-empty-icon">📁</div>
              <h3 className="wb-empty-title">NO SAVED WORKBENCHES YET</h3>
              <p className="wb-empty-subtitle">
                Start a reconstruction to create your first saved engineering project.
              </p>
              <button
                type="button"
                className="primary wb-empty-btn"
                onClick={handleStartReconstruction}
              >
                Start New Reconstruction
              </button>
            </div>
          ) : (
            /* Grid of Recent Workbenches */
            <div className="workbenches-grid">
              {workbenches.map((wb) => {
                const statusClass = wb.status === 'completed'
                  ? 'completed'
                  : wb.status === 'analyzed'
                  ? 'analyzed'
                  : 'draft';
                const statusLabel = wb.status === 'completed'
                  ? 'Model Ready'
                  : wb.status === 'analyzed'
                  ? 'Analyzed'
                  : 'Draft';

                const isRenaming = renamingId === wb.id;

                return (
                  <div
                    key={wb.id}
                    className="wb-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleResume(wb.id)}
                  >
                    <div className="wb-card-header">
                      <div className="wb-card-title-group">
                        {isRenaming ? (
                          <div
                            style={{ display: 'flex', gap: '4px' }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="text"
                              value={renameText}
                              onChange={(e) => setRenameText(e.target.value)}
                              style={{
                                padding: '3px 6px',
                                fontSize: '13px',
                                background: 'var(--bg)',
                                color: 'var(--text)',
                                border: '1px solid var(--primary)',
                              }}
                              autoFocus
                            />
                            <button
                              type="button"
                              className="wb-btn-icon"
                              onClick={(e) => handleSaveRename(e, wb.id)}
                            >
                              ✓
                            </button>
                          </div>
                        ) : (
                          <h3 className="wb-card-name" title={wb.name}>
                            {wb.name}
                          </h3>
                        )}
                        <span className="wb-card-component">
                          {wb.componentName || 'Mechanical Component'}
                        </span>
                      </div>

                      <span className={`wb-status-tag ${statusClass}`}>
                        {statusLabel}
                      </span>
                    </div>

                    {/* Stats Grid */}
                    <div className="wb-card-stats-grid">
                      <div className="wb-stat-item">
                        <span className="wb-stat-label">Images</span>
                        <span className="wb-stat-val">{wb.imageCount}</span>
                      </div>
                      <div className="wb-stat-item">
                        <span className="wb-stat-label">Analysis</span>
                        <span className={`wb-stat-val ${wb.hasAnalysis ? 'positive' : ''}`}>
                          {wb.hasAnalysis ? 'DONE' : 'NONE'}
                        </span>
                      </div>
                      <div className="wb-stat-item">
                        <span className="wb-stat-label">Geometry</span>
                        <span className={`wb-stat-val ${wb.hasGeometry ? 'active' : ''}`}>
                          {wb.hasGeometry ? 'READY' : 'PENDING'}
                        </span>
                      </div>
                      <div className="wb-stat-item">
                        <span className="wb-stat-label">Exports</span>
                        <span className="wb-stat-val">{wb.cadExportCount}</span>
                      </div>
                    </div>

                    {/* Footer */}
                    <div className="wb-card-footer">
                      <span className="wb-card-time">
                        {formatTimestamp(wb.updatedAt)}
                      </span>

                      <div className="wb-card-button-row">
                        <button
                          type="button"
                          className="wb-btn-icon"
                          title="Rename Workbench"
                          onClick={(e) => handleStartRename(e, wb)}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="wb-btn-icon delete"
                          title="Delete Workbench"
                          onClick={(e) => handleDelete(e, wb.id, wb.name)}
                        >
                          ✕
                        </button>
                        <button
                          type="button"
                          className="wb-btn-resume"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleResume(wb.id);
                          }}
                        >
                          Resume Workbench →
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* D. Account Details Section */}
        <section className="dashboard-section">
          <div className="section-label-row">
            <span className="section-eyebrow">ACCOUNT INFORMATION // ACTIVE PROFILE</span>
          </div>

          <div className="account-details-card">
            <div className="account-field">
              <span className="account-field-label">Full Name</span>
              <span className="account-field-value">{displayName}</span>
            </div>

            <div className="account-field">
              <span className="account-field-label">Username</span>
              <span className="account-field-value mono">{username}</span>
            </div>

            <div className="account-field">
              <span className="account-field-label">Account Type</span>
              <span className="account-field-value badge">
                {isAdmin ? 'Organization Admin' : 'Individual User'}
              </span>
            </div>

            <div className="account-field">
              <span className="account-field-label">Email</span>
              <span className="account-field-value mono">{email}</span>
            </div>

            {isAdmin && (
              <div className="account-field">
                <span className="account-field-label">Organization</span>
                <span className="account-field-value highlight">{orgTitle}</span>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
