import type { Pool } from 'pg';
import type { Params } from "../config.js";
import { flushUses } from './flush.js';
// E08: buffered "use" records flushed in batches (every useFlushMs or SIZE_THRESHOLD ids,
// whichever first) into one reinforcement transaction (FR-19/NFR-06).
export interface UseInput {
  nodeId: number;
  traceId?: number;
}

export interface UseBufferOptions {
  pool: Pool;
  params: Params;
  /** Interval ms; 0 or negative disables the interval path (timer only via startTimer). */
  useFlushMs: number;
  /** Injectable clock for tests; the buffer may use wall time, flush math does not. */
  now?: (d: Date) => number;
  /** Pending-entry threshold that triggers a flush; default 200. */
  sizeThreshold?: number;
  /** Flush application override (tests); default flushUses. */
  apply?: (
    pool: Pool,
    params: Params,
    uses: readonly UseInput[],
    now: number,
  ) => Promise<unknown>;
}

const DEFAULT_SIZE_THRESHOLD = 200;

export class UseBuffer {
  private readonly pool: Pool;
  private readonly params: Params;
  private readonly useFlushMs: number;
  private readonly nowFn: (d: Date) => number;
  private readonly sizeThreshold: number;
  private readonly applyFn: NonNullable<UseBufferOptions['apply']>;

  // Swap-and-empty semantics: `pending` is read by producers, `flushing` by the flush pass.
  private pending = new Map<string, UseInput>();
  private flushing = new Map<string, UseInput>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<void> | undefined;

  constructor(opts: UseBufferOptions) {
    this.pool = opts.pool;
    this.params = opts.params;
    this.useFlushMs = opts.useFlushMs;
    this.nowFn = opts.now ?? ((d: Date) => d.getTime());
    this.sizeThreshold = opts.sizeThreshold ?? DEFAULT_SIZE_THRESHOLD;
    this.applyFn = opts.apply ?? flushUses;
  }

  /** Buffer a use. Dedupes on (traceId, nodeId) within the pending set; flushes at the size threshold. */
  add(use: UseInput): void {
    const key = `${use.traceId ?? ''}:${use.nodeId}`;
    if (!this.pending.has(key)) this.pending.set(key, use);
    if (this.pending.size >= this.sizeThreshold && !this.flushing.size) void this.flush();
  }

  /** Number of entries not yet handed to a flush pass. */
  size(): number {
    return this.pending.size;
  }

  /**
   * Swap-and-empty then apply in one batch. Concurrent calls serialize: a second flush
   * while one is inflight drains only what arrived meanwhile.
   */
  flush(): Promise<void> {
    if (this.flushing.size) return this.inflight ?? Promise.resolve();
    const batch = this.pending;
    this.pending = new Map();
    if (!batch.size) return Promise.resolve();
    const now = this.nowFn(new Date());
    this.flushing = batch;
    this.inflight = this.applyFn(this.pool, this.params, [...batch.values()], now).then(
      () => undefined,
    ).finally(() => {
      this.flushing = new Map();
      this.inflight = undefined;
    });
    return this.inflight;
  }

  startTimer(): void {
    if (this.timer || this.useFlushMs <= 0) return;
    this.timer = setInterval(() => void this.flush(), this.useFlushMs);
    this.timer.unref?.();
  }

  /** Stop the interval; does not flush (shutdown path flushes explicitly). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
