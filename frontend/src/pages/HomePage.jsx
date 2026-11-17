import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Icon } from '../components/Icon.jsx';

export function HomePage() {
  const { user, organization, role, logout } = useAuth();

  return (
    <div className="home-dashboard-layout">
      {/* Top Navigation */}
      <header className="home-header">
        <div className="brand-group">
          <span className="brand-title">ReForge AI</span>
          <span className="cad readout">SYS: INDUSTRIAL GATEWAY</span>
        </div>

        <div className="user-profile-widget">
          <div className="user-meta">
            <span className="user-name">{user?.displayName || 'Engineer'}</span>
            <span className="org-badge">{organization?.name || 'Workspace'} ({role || 'viewer'})</span>
          </div>
          <button className="secondary icon-only" onClick={logout} title="Sign Out">
            <Icon>logout</Icon>
          </button>
        </div>
      </header>

      {/* Main Surface */}
      <main className="home-content">
        <div className="welcome-banner">
          <p className="eyebrow">ENGINEERING RECONSTRUCTION</p>
          <h1>Welcome, {user?.displayName || 'Colleague'}</h1>
          <p className="subtitle">
            Autonomous reverse-engineering pipeline for machinery synthesis and manufacturing intelligence.
          </p>
        </div>

        <div className="dashboard-grid">
          {/* New Part Action Card */}
          <div className="dashboard-card primary-card">
            <div className="card-tag">NEW PIPELINE</div>
            <h2>Synthesize New Machinery</h2>
            <p>Upload multi-angle component imagery to generate 3D models, manufacturing intelligence, and engineering drawings.</p>
            <div className="card-actions">
              <Link to="/app/new?view=upload" className="primary start-btn" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                Start New Reconstruction <Icon>arrow_forward</Icon>
              </Link>
            </div>
          </div>

          {/* Quick Stats / Session Info */}
          <div className="dashboard-card status-card">
            <div className="card-tag">SESSION STATUS</div>
            <h3>Organization Credentials</h3>
            <div className="status-item">
              <span className="status-label">Tenant ID:</span>
              <span className="status-val mono">{organization?.id ? `${organization.id.slice(0, 16)}...` : 'Local Org'}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Authorization Role:</span>
              <span className="status-val pill-role">{role}</span>
            </div>
            <div className="status-item">
              <span className="status-label">Email:</span>
              <span className="status-val">{user?.email}</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
