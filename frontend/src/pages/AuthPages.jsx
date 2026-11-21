import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export function LoginPage({ onNavigate }) {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!identifier.trim()) {
      setError('Please enter your username or email.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setLoading(true);
    try {
      await login(identifier, password);
      if (onNavigate) {
        onNavigate('home');
      }
    } catch (err) {
      setError(err.message || 'Invalid username/email or password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-eyebrow">SECURE ACCESS // REFORGE AI</div>
          <h1 className="auth-title">Sign In</h1>
          <p className="auth-subtitle">Access your reverse-engineering workspace and organization assets.</p>
        </div>

        {error && (
          <div className="auth-alert error" role="alert">
            <span className="auth-alert-icon">⚠️</span>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <div className="auth-field">
            <label htmlFor="login-identifier">Username or Email</label>
            <input
              id="login-identifier"
              type="text"
              autoComplete="username"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="e.g. admin-001 or user-01"
              disabled={loading}
            />
          </div>

          <div className="auth-field">
            <div className="field-label-row">
              <label htmlFor="login-password">Password</label>
            </div>
            <div className="password-input-wrap">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                disabled={loading}
              />
              <button
                type="button"
                className="pwd-toggle"
                onClick={() => setShowPassword(!showPassword)}
                title={showPassword ? 'Hide password' : 'Show password'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          <button type="submit" className="primary full-width auth-submit-btn" disabled={loading}>
            {loading ? (
              <span className="auth-btn-content">
                <span className="auth-spinner-sm" /> Authenticating...
              </span>
            ) : (
              'Sign In to ReForge'
            )}
          </button>
        </form>

        <div className="auth-footer">
          <span>Need a new account?</span>{' '}
          <button
            type="button"
            className="auth-link-btn"
            onClick={() => onNavigate && onNavigate('register')}
          >
            Register demo account
          </button>
        </div>
      </div>
    </div>
  );
}

export function RegisterPage({ onNavigate }) {
  const { register } = useAuth();
  const [role, setRole] = useState('user'); // 'user' | 'admin'
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [orgName, setOrgName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [registeredUser, setRegisteredUser] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (role === 'admin' && !orgName.trim()) {
      setError('Organization name is required for Organization Admin registration.');
      return;
    }
    if (!password) {
      setError('Please provide a password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await register({
        role,
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
        password,
        orgName: role === 'admin' ? orgName.trim() : undefined,
      });

      if (res?.user) {
        setRegisteredUser(res.user);
      }
    } catch (err) {
      setError(err.message || 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  if (registeredUser) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-header">
            <div className="auth-eyebrow">REGISTRATION SUCCESSFUL // REFORGE AI</div>
            <h1 className="auth-title">Account Created</h1>
            <p className="auth-subtitle">Your new demo account has been initialized and authenticated.</p>
          </div>

          <div className="auth-alert success" role="status">
            <div className="reg-success-summary">
              <div><strong>Generated Username:</strong> <code>{registeredUser.username}</code></div>
              <div><strong>Account Type:</strong> {registeredUser.role === 'admin' ? 'Organization Admin' : 'Individual User'}</div>
              {registeredUser.organization && (
                <div><strong>Organization:</strong> {registeredUser.organization.name}</div>
              )}
            </div>
          </div>

          <p className="auth-success-note">
            Your credentials have been securely stored in the application database. You may now continue into ReForge AI.
          </p>

          <button
            type="button"
            className="primary full-width"
            onClick={() => onNavigate && onNavigate('home')}
          >
            Enter Workbench
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-eyebrow">DEMO REGISTRATION // REFORGE AI</div>
          <h1 className="auth-title">Create Account</h1>
          <p className="auth-subtitle">Choose your account type to create a new demonstration profile.</p>
        </div>

        {/* Role Selector Tabs */}
        <div className="auth-role-tabs">
          <button
            type="button"
            className={`auth-role-tab ${role === 'user' ? 'active' : ''}`}
            onClick={() => { setRole('user'); setError(''); }}
          >
            Individual User
          </button>
          <button
            type="button"
            className={`auth-role-tab ${role === 'admin' ? 'active' : ''}`}
            onClick={() => { setRole('admin'); setError(''); }}
          >
            Organization Admin
          </button>
        </div>

        {error && (
          <div className="auth-alert error" role="alert">
            <span className="auth-alert-icon">⚠️</span>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          {role === 'admin' && (
            <div className="auth-field">
              <label htmlFor="reg-org">Organization Name *</label>
              <input
                id="reg-org"
                type="text"
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="e.g. Acme Precision Engineering"
                disabled={loading}
              />
            </div>
          )}

          <div className="auth-field">
            <label htmlFor="reg-name">Full Name</label>
            <input
              id="reg-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Priya Sharma"
              disabled={loading}
            />
          </div>

          <div className="auth-field">
            <label htmlFor="reg-email">Email Address (Optional)</label>
            <input
              id="reg-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. priya@example.com"
              disabled={loading}
            />
          </div>

          <div className="auth-field">
            <label htmlFor="reg-password">Password (min 6 characters) *</label>
            <div className="password-input-wrap">
              <input
                id="reg-password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                disabled={loading}
              />
              <button
                type="button"
                className="pwd-toggle"
                onClick={() => setShowPassword(!showPassword)}
                title={showPassword ? 'Hide password' : 'Show password'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          <div className="auth-field">
            <label htmlFor="reg-confirm">Confirm Password *</label>
            <input
              id="reg-confirm"
              type={showPassword ? 'text' : 'password'}
              required
              minLength={6}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••••••"
              disabled={loading}
            />
          </div>

          <div className="reg-info-box">
            <span>ℹ️ Usernames are automatically generated upon registration (e.g. <code>user-03</code> or <code>admin-002</code>).</span>
          </div>

          <button type="submit" className="primary full-width auth-submit-btn" disabled={loading}>
            {loading ? (
              <span className="auth-btn-content">
                <span className="auth-spinner-sm" /> Creating Account...
              </span>
            ) : (
              `Register as ${role === 'admin' ? 'Organization Admin' : 'User'}`
            )}
          </button>
        </form>

        <div className="auth-footer">
          <span>Already have an account?</span>{' '}
          <button
            type="button"
            className="auth-link-btn"
            onClick={() => onNavigate && onNavigate('login')}
          >
            Sign In with demo account
          </button>
        </div>
      </div>
    </div>
  );
}
