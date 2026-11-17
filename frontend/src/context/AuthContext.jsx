import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { getJson, postJson, setCsrfToken, setSessionExpiredHandler, resetSessionExpiredFlag, ApiError } from '../lib/api.js';

export const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

const LOGOUT_CHANNEL_NAME = 'reforge_auth_channel';

export function AuthProvider({ children }) {
  // State machine: 'booting' | 'offline' | 'authenticated' | 'unauthenticated' | 'expired'
  const [authState, setAuthState] = useState('booting');
  const [user, setUser] = useState(null);
  const [organization, setOrganization] = useState(null);
  const [role, setRole] = useState(null);
  const [sessionInfo, setSessionInfo] = useState(null);
  const [authError, setAuthError] = useState(null);

  // BroadcastChannel for cross-tab logout synchronization
  useEffect(() => {
    let channel = null;
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        channel = new BroadcastChannel(LOGOUT_CHANNEL_NAME);
        channel.onmessage = (event) => {
          if (event.data?.type === 'LOGOUT') {
            setUser(null);
            setOrganization(null);
            setRole(null);
            setSessionInfo(null);
            setCsrfToken(null);
            setAuthState('unauthenticated');
            // Full reload on cross-tab logout to clear any in-memory state
            window.location.href = '/login';
          }
        };
      }
    } catch (e) {
      // BroadcastChannel optional fallback
    }

    return () => {
      if (channel) channel.close();
    };
  }, []);

  // Register session expiry handler
  useEffect(() => {
    setSessionExpiredHandler((code) => {
      setAuthState('expired');
    });
  }, []);

  // Boot check: calls /api/auth/me on mount
  const checkSession = useCallback(async () => {
    setAuthState('booting');
    setAuthError(null);
    resetSessionExpiredFlag();

    try {
      const data = await getJson('/api/auth/me');
      if (data && data.user) {
        setUser(data.user);
        setOrganization(data.organization);
        setRole(data.role);
        setSessionInfo(data.session);
        setCsrfToken(data.csrfToken);
        setAuthState('authenticated');
      } else {
        setAuthState('unauthenticated');
      }
    } catch (err) {
      if (err.status === 0 || err.code === 'network_error') {
        // Backend unreachable
        setAuthState('offline');
        setAuthError('Cannot reach the ReForge AI server.');
      } else {
        // 401 unauthenticated / expired / no session
        setUser(null);
        setOrganization(null);
        setRole(null);
        setSessionInfo(null);
        setCsrfToken(null);
        setAuthState('unauthenticated');
      }
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // Login action
  const login = useCallback(async (email, password) => {
    const data = await postJson('/api/auth/login', { email, password });
    setUser(data.user);
    setOrganization(data.organization);
    setRole(data.role);
    setCsrfToken(data.csrfToken);
    setAuthState('authenticated');
    resetSessionExpiredFlag();
    return data;
  }, []);

  // Register action
  const register = useCallback(async (payload) => {
    const data = await postJson('/api/auth/register', payload);
    if (data?.user) {
      setUser(data.user);
      setOrganization(data.organization);
      setRole(data.role);
      setCsrfToken(data.csrfToken);
      setAuthState('authenticated');
      resetSessionExpiredFlag();
    }
    return data;
  }, []);

  // Logout action (cross-tab notify + hard reload)
  const logout = useCallback(async () => {
    try {
      await postJson('/api/auth/logout', {});
    } catch (e) {
      // Continue even if network fails
    }

    // Broadcast to other tabs
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        const channel = new BroadcastChannel(LOGOUT_CHANNEL_NAME);
        channel.postMessage({ type: 'LOGOUT' });
        channel.close();
      }
    } catch (e) {}

    // Clear user cached items
    try {
      localStorage.removeItem('reforge_report_draft');
      localStorage.removeItem('reforge_mfg_decisions');
    } catch (e) {}

    setUser(null);
    setOrganization(null);
    setRole(null);
    setSessionInfo(null);
    setCsrfToken(null);
    setAuthState('unauthenticated');

    // Hard navigation to reset memory completely
    window.location.href = '/login';
  }, []);

  const value = useMemo(() => ({
    authState,
    user,
    organization,
    role,
    sessionInfo,
    authError,
    checkSession,
    login,
    register,
    logout,
    setAuthState,
  }), [authState, user, organization, role, sessionInfo, authError, checkSession, login, register, logout]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
