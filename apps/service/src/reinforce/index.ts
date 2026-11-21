import type { Pool } from 'pg';
import { UseBuffer, type UseInput } from './buffer.js';
import type { Params } from '../config.js';

// Entrypoint wire-up for E08: the buffer/flush side ships here; the E06/E07 entrypoint
// (and E09/E10 producers) only call `attachUseBuffer` and then `app.useBuffer.add`.
// Fastify itself is not a dependency of this scaffold yet, so the host is typed
// structurally: any app object with a `decorate` (Fastify-style) works.

export interface UseBufferHost {
  decorate(name: string, value: unknown): unknown;
}

export interface UseBufferOwner {
  useBuffer: UseBuffer;
}

// Params at wire-up time; effective-param updates mid-process are re-read by the
// entrypoint if it restarts the buffer (not expected: params are loaded once at boot).
export interface AttachUseBufferOptions {
  pool: Pool;
  params: Params;
  useFlushMs: number;
  sizeThreshold?: number;
  /** Signals that trigger the shutdown flush; overridable for tests. */
  signals?: readonly string[];
}

/**
 * Instantiate one UseBuffer per app instance, start its interval, register the
 * SIGTERM/shutdown flush (FR-19/NFR-06: pending uses flushed before exit so at most
 * one flush interval of uses is lost), and decorate the app with the buffer so
 * routes/worker (E09/E10) can call `buffer.add`.
 */
export function attachUseBuffer(
  app: UseBufferHost,
  opts: AttachUseBufferOptions,
): UseBuffer {
  const buffer = new UseBuffer({
    pool: opts.pool,
    params: opts.params,
    useFlushMs: opts.useFlushMs,
    ...(opts.sizeThreshold === undefined ? {} : { sizeThreshold: opts.sizeThreshold }),
  });
  buffer.startTimer();

  const signals = opts.signals ?? ['SIGTERM'];
  const shutdown = () => buffer.flush();
  for (const signal of signals) {
    process.on(signal, shutdown);
  }

  app.decorate('useBuffer', buffer);
  return buffer;
}

export type { UseInput };
