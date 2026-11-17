import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { sanitizeReturnTo } from '../lib/auth-util.js';
import { Icon } from './Icon.jsx';

export { sanitizeReturnTo };

export function RequireAuth({ children, requiredRole = null }) {
  const { authState, role, authError, checkSession } = useAuth();
  const location = useLocation();

  if (authState === 'booting') {
    return (
      <div className="auth-splash">
        <div className="auth-splash-card">
          <div className="cad readout">SYS: CONNECTING // REFORGE AUTH</div>
          <div className="auth-spinner"></div>
          <p>Initialising secure engineering session...</p>
        </div>
      </div>
    );
  }

  if (authState === 'offline') {
    return (
      <div className="auth-splash">
        <div className="auth-splash-card error">
          <div className="cad readout">STATUS: OFFLINE</div>
          <h2>Cannot reach ReForge server</h2>
          <p>{authError || 'The backend gateway could not be contacted.'}</p>
          <button className="primary" onClick={checkSession}>
            <Icon>refresh</Icon> Retry Connection
          </button>
        </div>
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }

  // Role hierarchy check if role required
  if (requiredRole) {
    const hierarchy = { owner: 4, admin: 3, engineer: 2, viewer: 1 };
    const userLvl = hierarchy[role] || 0;
    const reqLvl = hierarchy[requiredRole] || 0;
    if (userLvl < reqLvl) {
      return (
        <div className="auth-splash">
          <div className="auth-splash-card error">
            <div className="cad readout">ACCESS DENIED // 403 FORBIDDEN</div>
            <h2>Permission Required</h2>
            <p>Your role ({role}) does not have permission to access this engineering tool (requires {requiredRole}).</p>
            <a href="/home" className="primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
              Return to Dashboard
            </a>
          </div>
        </div>
      );
    }
  }

  return children;
}

export function SessionExpiryOverlay() {
  const { authState, checkSession } = useAuth();
  const [relogEmail, setRelogEmail] = React.useState('');
  const [relogPassword, setRelogPassword] = React.useState('');
  const [relogError, setRelogError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const { login } = useAuth();

  if (authState !== 'expired') return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setRelogError('');
    try {
      await login(relogEmail, relogPassword);
    } catch (err) {
      setRelogError(err.message || 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="session-expiry-backdrop">
      <div className="session-expiry-dialog">
        <div className="cad readout">SECURITY // SESSION EXPIRED</div>
        <h3>Engineering Session Expired</h3>
        <p>Your session has expired or was revoked. Your active unsaved workbench state has been preserved beneath this screen.</p>

        {relogError && <div className="auth-form-error">{relogError}</div>}

        <form onSubmit={handleSubmit} className="auth-form-compact">
          <div className="auth-field">
            <label>Email</label>
            <input
              type="email"
              required
              value={relogEmail}
              onChange={(e) => setRelogEmail(e.target.value)}
              placeholder="engineer@company.com"
            />
          </div>
          <div className="auth-field">
            <label>Password</label>
            <input
              type="password"
              required
              value={relogPassword}
              onChange={(e) => setRelogPassword(e.target.value)}
              placeholder="••••••••••••"
            />
          </div>
          <button type="submit" className="primary" disabled={loading}>
            {loading ? 'Resuming...' : 'Re-authenticate & Resume'}
          </button>
        </form>
      </div>
    </div>
  );
}
