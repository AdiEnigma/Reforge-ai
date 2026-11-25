import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { getJson, postJson, ApiError } from '../lib/api.js';

export const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export function AuthProvider({ children }) {
  // State machine: 'booting' | 'authenticated' | 'unauthenticated' | 'offline'
  const [authState, setAuthState] = useState('booting');
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);

  // Checks active session from backend GET /api/auth/me
  const checkSession = useCallback(async () => {
    setAuthState('booting');
    setAuthError(null);

    try {
      const data = await getJson('/api/auth/me');
      if (data && data.user) {
        setUser(data.user);
        setAuthState('authenticated');
      } else {
        setUser(null);
        setAuthState('unauthenticated');
      }
    } catch (err) {
      if (err.status === 0) {
        // Backend offline / unreachable
        setAuthState('offline');
        setAuthError('Cannot reach the ReForge AI server. Is it running on http://localhost:8787?');
      } else {
        // 401 unauthenticated
        setUser(null);
        setAuthState('unauthenticated');
      }
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // Login action: POST /api/auth/login
  const login = useCallback(async (identifier, password) => {
    setAuthError(null);
    const data = await postJson('/api/auth/login', {
      identifier: identifier.trim(),
      password,
    });
    if (data?.user) {
      setUser(data.user);
      setAuthState('authenticated');
    }
    return data;
  }, []);

  // Register action: POST /api/auth/register
  const register = useCallback(async ({ role = 'user', displayName, email, password, orgName }) => {
    setAuthError(null);
    const data = await postJson('/api/auth/register', {
      role,
      displayName,
      email,
      password,
      orgName,
    });
    if (data?.user) {
      setUser(data.user);
      setAuthState('authenticated');
    }
    return data;
  }, []);

  // Logout action: POST /api/auth/logout
  const logout = useCallback(async () => {
    try {
      await postJson('/api/auth/logout', {});
    } catch (e) {
      // Continue even if network failed
    }
    setUser(null);
    setAuthState('unauthenticated');
  }, []);

  const value = useMemo(() => ({
    authState,
    user,
    organization: user?.organization || null,
    role: user?.role || null,
    authError,
    checkSession,
    login,
    register,
    logout,
  }), [authState, user, authError, checkSession, login, register, logout]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
