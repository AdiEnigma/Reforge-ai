import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError,
  setCsrfToken,
  getCsrfToken,
  apiFetch,
  setSessionExpiredHandler,
  resetSessionExpiredFlag,
} from './api.js';

import { sanitizeReturnTo } from './auth-util.js';

// ─── 1. sanitizeReturnTo Security Tests ───────────────────────────────────────

test('P5 Security: sanitizeReturnTo rejects open redirects and external schemes', () => {
  // Safe relative paths accepted
  assert.equal(sanitizeReturnTo('/home'), '/home');
  assert.equal(sanitizeReturnTo('/app/new?view=upload'), '/app/new?view=upload');
  assert.equal(sanitizeReturnTo('/parts/123'), '/parts/123');

  // External URLs rejected
  assert.equal(sanitizeReturnTo('https://evil.com'), '/home');
  assert.equal(sanitizeReturnTo('http://attacker.com/steal'), '/home');
  assert.equal(sanitizeReturnTo('//evil.com/phish'), '/home');
  assert.equal(sanitizeReturnTo('javascript:alert(1)'), '/home');
  assert.equal(sanitizeReturnTo('data:text/html,hack'), '/home');

  // Null, empty, or undefined fallback
  assert.equal(sanitizeReturnTo(null), '/home');
  assert.equal(sanitizeReturnTo(''), '/home');
  assert.equal(sanitizeReturnTo(undefined), '/home');
});

// ─── 2. In-Memory CSRF Storage Tests ──────────────────────────────────────────

test('P5 Security: CSRF token is kept strictly in-memory and not stored in localStorage', () => {
  setCsrfToken('test-csrf-token-12345');
  assert.equal(getCsrfToken(), 'test-csrf-token-12345');

  setCsrfToken(null);
  assert.equal(getCsrfToken(), null);
});

// ─── 3. Typed API Client Error Normalization ──────────────────────────────────

test('P5 API Client: Handles ApiError properties and response envelope', async () => {
  const err = new ApiError('Test error message', 403, 'forbidden', { reason: 'insufficient_role' });
  assert.equal(err.message, 'Test error message');
  assert.equal(err.status, 403);
  assert.equal(err.code, 'forbidden');
  assert.equal(err.details.reason, 'insufficient_role');
});

// ─── 4. Single-Flight Session Expiry Callback ─────────────────────────────────

test('P5 API Client: Single-flight session_expired invokes handler exactly once', async () => {
  let callCount = 0;
  let lastCode = null;

  resetSessionExpiredFlag();
  setSessionExpiredHandler((code) => {
    callCount += 1;
    lastCode = code;
  });

  // Mock global fetch to return 401 session_expired
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    headers: {
      get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => ({ error: { code: 'session_expired', message: 'Session expired' } }),
  });

  try {
    // First call -> triggers callback
    await assert.rejects(async () => {
      await apiFetch('/api/engineering-simulate', { method: 'POST' });
    });
    assert.equal(callCount, 1);
    assert.equal(lastCode, 'session_expired');

    // Second call -> single-flight flag prevents duplicate invocation
    await assert.rejects(async () => {
      await apiFetch('/api/engineering-simulate', { method: 'POST' });
    });
    assert.equal(callCount, 1, 'Callback must not be invoked a second time in single-flight');
  } finally {
    globalThis.fetch = originalFetch;
    resetSessionExpiredFlag();
  }
});
