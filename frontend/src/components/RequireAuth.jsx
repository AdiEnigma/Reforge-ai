import React from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export function RequireAuth({ children, onNavigate }) {
  const { authState, authError, checkSession } = useAuth();

  if (authState === 'booting') {
    return (
      <div className="auth-splash">
        <div className="auth-splash-card">
          <div className="auth-eyebrow">SYS: CONNECTING // REFORGE AUTH</div>
          <div className="auth-spinner" />
          <p>Restoring authenticated reverse-engineering session...</p>
        </div>
      </div>
    );
  }

  if (authState === 'offline') {
    return (
      <div className="auth-splash">
        <div className="auth-splash-card error">
          <div className="auth-eyebrow">STATUS: OFFLINE</div>
          <h2>Cannot reach ReForge server</h2>
          <p>{authError || 'The backend gateway could not be contacted.'}</p>
          <div className="auth-splash-actions">
            <button className="primary" onClick={checkSession}>
              Retry Connection
            </button>
            {onNavigate && (
              <button className="secondary" onClick={() => onNavigate('login')}>
                Go to Sign In
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    if (onNavigate) {
      // Trigger navigation to login
      setTimeout(() => onNavigate('login'), 0);
    }
    return (
      <div className="auth-splash">
        <div className="auth-splash-card">
          <div className="auth-eyebrow">AUTHENTICATION REQUIRED</div>
          <div className="auth-spinner" />
          <p>Redirecting to Sign In...</p>
        </div>
      </div>
    );
  }

  return children;
}
