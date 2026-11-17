import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { sanitizeReturnTo } from '../components/RequireAuth.jsx';
import { Icon } from '../components/Icon.jsx';
import { getJson } from '../lib/api.js';

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = sanitizeReturnTo(searchParams.get('returnTo'));
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(email, password);
      navigate(returnTo, { replace: true });
    } catch (err) {
      if (err.status === 429) {
        setError(`Too many failed attempts. Please retry in ${err.retryAfter || 60} seconds.`);
      } else if (err.code === 'email_not_verified') {
        setError('Your email has not been verified yet. Please check your inbox.');
      } else {
        setError(err.message || 'Invalid email or password.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="cad readout">SECURE LOGIN // REFORGE AI</div>
          <h1>Sign In</h1>
          <p>Access your reverse-engineering workbench and organization assets.</p>
        </div>

        {error && <div className="auth-alert error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-field">
            <label htmlFor="login-email">Email Address</label>
            <input
              id="login-email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="engineer@company.com"
            />
          </div>

          <div className="auth-field">
            <div className="field-label-row">
              <label htmlFor="login-password">Password</label>
              <Link to="/forgot-password" className="auth-link small">Forgot password?</Link>
            </div>
            <div className="password-input-wrap">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
              <button
                type="button"
                className="pwd-toggle"
                onClick={() => setShowPassword(!showPassword)}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                <Icon>{showPassword ? 'visibility_off' : 'visibility'}</Icon>
              </button>
            </div>
          </div>

          <button type="submit" className="primary full-width" disabled={loading}>
            {loading ? 'Authenticating...' : 'Sign In to ReForge'}
          </button>
        </form>

        <div className="auth-footer">
          <span>Need an account?</span>{' '}
          <Link to="/register" className="auth-link">Register with invite code</Link>
        </div>
      </div>
    </div>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const { register } = useAuth();

  const [orgName, setOrgName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingVerification, setPendingVerification] = useState(false);
  const [registrationMode, setRegistrationMode] = useState('open'); // 'open' | 'invite_only'

  // Fetch safe registration configuration from backend
  useEffect(() => {
    let active = true;
    getJson('/api/auth/config')
      .then((cfg) => {
        if (active && cfg?.registrationMode) {
          setRegistrationMode(cfg.registrationMode);
        }
      })
      .catch(() => {
        // Safe fallback in offline mode
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await register({
        orgName,
        displayName,
        email,
        password,
        inviteCode: registrationMode === 'invite_only' ? (inviteCode || null) : null,
      });

      if (result?.status === 'pending_verification' || !result?.user) {
        setPendingVerification(true);
      } else {
        navigate('/home', { replace: true });
      }
    } catch (err) {
      if (err.status === 403 && err.code === 'invite_code_required') {
        setError('An invitation code is required during the ReForge pilot.');
      } else {
        setError(err.message || 'Registration failed.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (pendingVerification) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-header">
            <div className="cad readout">VERIFICATION REQUIRED</div>
            <h1>Check Your Inbox</h1>
            <p>A verification email has been dispatched to <strong>{email}</strong>.</p>
            <p>Please open the link to complete account setup and enter your organization workspace.</p>
            <div style={{ marginTop: 24 }}>
              <Link to="/login" className="primary" style={{ display: 'inline-block', textDecoration: 'none', padding: '10px 16px' }}>
                Return to Login
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isInviteOnly = registrationMode === 'invite_only';

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="cad readout">
            {isInviteOnly ? 'INVITATION REGISTRATION // REFORGE AI' : 'OPEN WORKSPACE REGISTRATION // REFORGE AI'}
          </div>
          <h1>Create Organization</h1>
          <p>
            {isInviteOnly
              ? 'Enter your invitation code to establish your organization workspace.'
              : 'Register your organization to start reverse-engineering mechanical components.'}
          </p>
        </div>

        {error && <div className="auth-alert error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-field">
            <label htmlFor="reg-org">Organization / Company Name</label>
            <input
              id="reg-org"
              type="text"
              required
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Indus Forgings Pvt Ltd"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="reg-name">Your Full Name</label>
            <input
              id="reg-name"
              type="text"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Aditya Sharma"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="reg-email">Work Email</label>
            <input
              id="reg-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="engineer@indusforgings.com"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="reg-password">Password (min 10 characters)</label>
            <div className="password-input-wrap">
              <input
                id="reg-password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
              <button
                type="button"
                className="pwd-toggle"
                onClick={() => setShowPassword(!showPassword)}
              >
                <Icon>{showPassword ? 'visibility_off' : 'visibility'}</Icon>
              </button>
            </div>
          </div>

          {isInviteOnly && (
            <div className="auth-field">
              <label htmlFor="reg-invite">Invitation Code (Required)</label>
              <input
                id="reg-invite"
                type="text"
                required
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="RF-XXXXXX..."
              />
            </div>
          )}

          <button type="submit" className="primary full-width" disabled={loading}>
            {loading ? 'Creating Organization...' : 'Complete Registration'}
          </button>
        </form>

        <div className="auth-footer">
          <span>Already have an account?</span>{' '}
          <Link to="/login" className="auth-link">Sign In</Link>
        </div>
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { postJson } = await import('../lib/api.js');
      await postJson('/api/auth/forgot-password', { email });
      setSubmitted(true);
    } catch (err) {
      if (err.status === 429) {
        setError(`Too many requests. Please wait before retrying.`);
      } else {
        // Uniform success on 202 to prevent email enumeration
        setSubmitted(true);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="cad readout">SECURITY // ACCOUNT RECOVERY</div>
          <h1>Reset Password</h1>
          <p>Enter your account email to receive password recovery instructions.</p>
        </div>

        {error && <div className="auth-alert error">{error}</div>}

        {submitted ? (
          <div className="auth-alert success">
            If an active account exists for <strong>{email}</strong>, a recovery link has been dispatched. Please check your inbox.
            <div style={{ marginTop: 16 }}>
              <Link to="/login" className="auth-link">Back to Sign In</Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="auth-form">
            <div className="auth-field">
              <label htmlFor="forgot-email">Email Address</label>
              <input
                id="forgot-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="engineer@company.com"
              />
            </div>

            <button type="submit" className="primary full-width" disabled={loading}>
              {loading ? 'Sending Instructions...' : 'Send Reset Link'}
            </button>

            <div className="auth-footer">
              <Link to="/login" className="auth-link">Back to Sign In</Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 10) {
      setError('Password must be at least 10 characters long.');
      return;
    }

    setLoading(true);
    try {
      const { postJson } = await import('../lib/api.js');
      await postJson('/api/auth/reset-password', { token, newPassword: password });
      setSuccess(true);
    } catch (err) {
      setError(err.message || 'Invalid or expired reset token.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="cad readout">SECURITY // NEW PASSWORD</div>
          <h1>Set New Password</h1>
        </div>

        {error && <div className="auth-alert error">{error}</div>}

        {success ? (
          <div className="auth-alert success">
            Your password has been successfully updated. All previous sessions have been revoked.
            <div style={{ marginTop: 16 }}>
              <button className="primary" onClick={() => navigate('/login')}>
                Sign In With New Password
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="auth-form">
            <div className="auth-field">
              <label>New Password (min 10 characters)</label>
              <input
                type="password"
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
            </div>

            <div className="auth-field">
              <label>Confirm New Password</label>
              <input
                type="password"
                required
                minLength={10}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••••••"
              />
            </div>

            <button type="submit" className="primary full-width" disabled={loading || !token}>
              {loading ? 'Updating Password...' : 'Save Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [status, setStatus] = useState('idle'); // 'loading' | 'success' | 'error'
  const [message, setMessage] = useState('');

  React.useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('Missing verification token in URL.');
      return;
    }

    let isMounted = true;
    (async () => {
      setStatus('loading');
      try {
        const { postJson } = await import('../lib/api.js');
        await postJson('/api/auth/verify-email', { token });
        if (isMounted) {
          setStatus('success');
          setMessage('Your email address has been verified successfully!');
        }
      } catch (err) {
        if (isMounted) {
          setStatus('error');
          setMessage(err.message || 'Verification token is invalid or has expired.');
        }
      }
    })();

    return () => { isMounted = false; };
  }, [token]);

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="cad readout">VERIFICATION // REFORGE AI</div>
          <h1>Email Verification</h1>
        </div>

        {status === 'loading' && (
          <div className="auth-alert">
            <div className="auth-spinner"></div>
            Verifying your security credentials...
          </div>
        )}

        {status === 'success' && (
          <div className="auth-alert success">
            {message}
            <div style={{ marginTop: 16 }}>
              <Link to="/login" className="primary" style={{ display: 'inline-block', textDecoration: 'none', padding: '8px 16px' }}>
                Proceed to Sign In
              </Link>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="auth-alert error">
            {message}
            <div style={{ marginTop: 16 }}>
              <Link to="/login" className="auth-link">Return to Sign In</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
