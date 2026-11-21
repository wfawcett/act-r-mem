// §11.2 step 1 / NFR-11: secret redaction applied before any model call and to
// all log/error lines.
export const REDACTION = '[redacted]';

/**
 * Ordered patterns replaced with `[redacted]`. Exported so the NFR-11 corpus
 * test can assert coverage of every class.
 */
export const REDACT_PATTERNS: RegExp[] = [
  // PEM private keys (-----BEGIN ... PRIVATE KEY----- ... -----END-----)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Authorization: Bearer <token> (header value or inline "Bearer tok")
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // OpenAI-style sk- keys (sk-... >= 20 chars of key material)
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // GitHub personal access tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // AWS access key ids
  /\bAKIA[0-9A-Z]{16}\b/g,
  // scheme://user:password@host URLs
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
];

/** Replace every secret-shaped substring of `text` with `[redacted]`. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, REDACTION);
  }
  return out;
}
