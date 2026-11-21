import { describe, expect, it } from 'vitest';
import { REDACTION, REDACT_PATTERNS, redact } from '../src/ingest/redact.js';

const CORPUS: [string, string][] = [
  ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowABCDEF\n-----END RSA PRIVATE KEY-----', 'private key'],
  ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig', 'bearer token'],
  ['key: sk-proj-abcdefghijklmnopqrstuvwxyz123456', 'sk- key'],
  ['token: ghp_abcdefghijklmnopqrstuvwxyz123456', 'ghp_ token'],
  ['creds: AKIAIOSFODNN7EXAMPLE', 'AWS access key'],
  ['db: postgres://recall:s3cret@localhost:5433/db', 'password URL'],
];

describe('redact', () => {
  it('replaces every NFR-11 corpus secret with [redacted]', () => {
    for (const [secret] of CORPUS) {
      const out = redact(`leaked: ${secret}`);
      expect(out).not.toContain(secret.slice(0, 20));
      expect(out).toContain(REDACTION);
    }
  });

  it('leaves ordinary text untouched', () => {
    const text = 'Alice met Bob at the 2026 offsite; discussed skunkworks project 42.';
    expect(redact(text)).toBe(text);
  });

  it('handles mixed content in one pass', () => {
    const out = redact('use sk-abcdefghijklmnopqrstuvwxyz123456 then AKIAIOSFODNN7EXAMPLE ok');
    expect(out).toBe(`use ${REDACTION} then ${REDACTION} ok`);
  });

  it('exports a pattern list covering each secret class', () => {
    expect(REDACT_PATTERNS.length).toBeGreaterThanOrEqual(CORPUS.length);
    for (const pattern of REDACT_PATTERNS) {
      expect(pattern.global).toBe(true);
    }
  });
});
