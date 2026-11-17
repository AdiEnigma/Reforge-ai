/**
 * Validates returnTo path to prevent open redirects.
 * Must start with single '/', not contain schemes, not start with '//'.
 */
export function sanitizeReturnTo(path) {
  if (!path || typeof path !== 'string') return '/home';
  const trimmed = path.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes(':')) {
    return '/home';
  }
  return trimmed;
}
