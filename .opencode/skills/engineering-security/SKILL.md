---
name: engineering-security
description: Ensure safe application and file processing. Covers secure image uploads, file type and size validation, API authentication and authorisation, API rate limiting, secure temporary file handling, path traversal prevention, safe CAD export handling, Gemini API key protection, environment variables, dependency security, and avoiding unsafe execution of user-supplied geometry scripts.
---

# Engineering Security

## Purpose

Ensure safe application and file processing in ReForge AI. Prevent malicious inputs, secure API endpoints, and protect sensitive data throughout the system.

## When to use

- When implementing or modifying file upload handling.
- When designing API endpoints.
- When validating file types and sizes.
- When implementing authentication and authorization.
- When handling temporary files.
- When validating user-supplied geometry scripts.
- When managing environment variables and secrets.
- When ensuring dependency security.

## Project context

ReForge AI processes user-uploaded images and executes CAD generation. Security is critical to prevent malicious inputs, protect API keys, and ensure system integrity.

### Secure image uploads

**File type validation:**
- Validate MIME type (image/jpeg, image/png, image/webp)
- Reject non-image types
- Validate base64 data integrity

**File size limits:**
- Max 8 images per request
- Max 20 MB per image (20 MB total payload)
- Reject oversized images early

**Base64 validation:**
- Validate base64 data integrity
- Reject corrupted or malformed data
- Use `fileToPayload()` utility for safe decoding

### API security

**Authentication and authorization:**
- Implement API key authentication for backend services
- Use JWT or OAuth for user authentication (if needed)
- Enforce role-based access control for sensitive endpoints
- Validate user permissions before processing

**Rate limiting:**
- Implement rate limiting on `/api/analyze-component`
- Use token bucket algorithm
- Limit to reasonable request rates (e.g., 60 requests/minute)

**Input validation:**
- Validate all request payloads
- Use Pydantic models for request validation
- Sanitize user inputs before processing

### Secure temporary file handling

**Temporary files:**
- Use secure temporary directories
- Clean up immediately after processing
- Never leave files on disk longer than necessary
- Use secure file naming (randomized, non-guessable)

**Path traversal prevention:**
- Sanitize all file paths
- Use os.path.realpath() to resolve paths
- Reject paths containing ".." sequences
- Validate file extensions against allowed list

### Safe CAD export handling

**Export validation:**
- Validate CAD model before export
- Check for degenerate geometry
- Verify solid validity
- Check bounding box dimensions
- Verify export manifest

**Export manifest validation:**
- Verify file paths are within allowed directories
- Check file sizes are reasonable
- Validate file formats are supported

### Gemini API key protection

**Key management:**
- Store API key in environment variable (`GEMINI_API_KEY`)
- Never expose key to frontend
- Keep key in backend only
- Rotate keys regularly
- Monitor API usage for anomalies

**Key protection:**
- Use environment variable management (e.g., .env.local)
- Keep `.env` files gitignored
- Use secrets management in production

### Environment variables

**Security practices:**
- Use environment variables for all configuration
- Never hardcode secrets in code
- Use different environments (dev, staging, prod)
- Restrict access to environment variables

**Key variables:**
- `GEMINI_API_KEY` — Gemini API key (server-side only)
- `VISION_SERVICE_URL` — Vision service URL
- `VISION_FAIL_OPEN` — Fail-open flag
- `RECONSTRUCTION_ENABLED` — Reconstruction enable flag

### Dependency security

**Dependency management:**
- Use pinned versions in requirements files
- Regularly update dependencies
- Use dependency scanning tools
- Monitor for known vulnerabilities

**Security scanning:**
- Run dependency scanning regularly
- Address high-severity vulnerabilities immediately
- Prefer well-maintained dependencies

### Avoiding unsafe execution

**User-supplied geometry scripts:**
- Never execute user-supplied code directly
- Parse and validate geometry recipes
- Use validated `CadSpec` objects
- Never execute arbitrary code from images

**Script validation:**
- Validate script syntax before execution
- Parse geometry recipes into structured format
- Use feature schema validation
- Reject malformed or dangerous scripts

### Error handling and logging

**Secure error handling:**
- Return generic error messages to users
- Log detailed errors internally
- Avoid exposing stack traces to users

**Secure logging:**
- Log security-relevant events (auth failures, file uploads)
- Sanitize sensitive data in logs
- Use structured logging for auditability

## Implementation guidelines

1. **Validate all inputs** — Every API endpoint must validate inputs
2. **Use fail-open pattern** — Optional services should degrade gracefully
3. **Validate file types and sizes** — Always check MIME type and size
4. **Sanitize file paths** — Prevent path traversal attacks
5. **Use secure temporary files** — Clean up immediately after processing
6. **Protect API keys** — Never expose secrets to the client
7. **Validate file formats** — Only allow supported export formats
8. **Validate CAD models** — Check for degenerate geometry before export
9. **Use secure logging** — Log security-relevant events without exposing secrets
10. **Monitor API usage** — Detect anomalies in API usage patterns

## Common mistakes to avoid

- **Not validating file types** — Allowing arbitrary file uploads is a major security risk
- **Hardcoding secrets** — API keys should never be in code
- **Ignoring path traversal** — Path traversal can lead to arbitrary file access
- **Not validating export formats** — Malformed exports can cause crashes
- **Not sanitizing user inputs** — XSS or injection attacks
- **Not monitoring API usage** — Security incidents often go unnoticed
- **Not updating dependencies** — Known vulnerabilities in dependencies
- **Not validating API keys** — Unauthorized API access
- **Not handling OOM gracefully** — Crashes can lead to denial of service
- **Not cleaning up temporary files** — Can lead to disk exhaustion

## Validation checklist

- [ ] All image uploads validate MIME type and size
- [ ] Base64 data integrity is validated
- [ ] File paths are sanitized for traversal prevention
- [ ] Temporary files are cleaned up immediately
- [ ] API endpoints validate inputs and authenticate users
- [ ] Rate limiting is implemented on sensitive endpoints
- [ ] Gemini API key is stored in environment variable and not exposed
- [ ] Environment variables are managed securely
- [ ] Dependencies are scanned for vulnerabilities
- [ ] User-supplied geometry scripts are parsed and validated
- [ ] Error messages are generic and do not expose sensitive information
- [ ] Secure logging is implemented for security-relevant events
- [ ] API rate limiting is enforced on `/api/analyze-component`
- [ ] Export validation checks CAD model validity before export
- [ ] Environment variables are managed securely