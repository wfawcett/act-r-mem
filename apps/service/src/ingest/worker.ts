// §11.1 background worker: `workerConcurrency` slots poll the ingest queue every
// 1 s and claim exactly one pending item each via FOR UPDATE SKIP LOCKED, so
// concurrent workers (or slots) never process the same item. Outcomes:
// 'done' → row done; 'retry' or a throw → attempts < 5 requeues with
// exponential backoff (2^attempts s) and a redacted last_error, otherwise the
// row fails; items stuck 'processing' > 10 min are requeued on startup and
// every 5 min. stop() stops claiming and awaits in-flight processing.
// Nothing here logs item text or raw error strings (§11.2.1, NFR-11).
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { createClient } from '../llm/client.js';
import { processItem, type ProcessDeps, type QueueItem } from './process.js';
import { redact } from './redact.js';

const MAX_ATTEMPTS = 5;
const POLL_MS = 1000;
const STUCK_AFTER = "interval '10 minutes'";
const STUCK_SWEEP_MS = 5 * 60 * 1000;

// §11.1 claim: one pending, due item per call, atomically marked processing.
const CLAIM_SQL = `
UPDATE ingest_queue
SET status = 'processing', started_at = now(), attempts = attempts + 1
WHERE id = (
  SELECT id FROM ingest_queue
  WHERE status = 'pending' AND run_after <= now()
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *`;

export interface WorkerHandle {
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function startWorker(pool: Pool, config: Config): WorkerHandle {
  const deps: ProcessDeps = { client: createClient(config), config };
  const concurrency = Math.max(1, config.workerConcurrency);
  let stopping = false;
  const slots: Promise<void>[] = [];

  // Items stuck in 'processing' (e.g. a killed process) must be requeued or
  // they are lost forever; sweep on startup and every 5 minutes.
  const sweep = () =>
    pool.query(
      `UPDATE ingest_queue
       SET status = 'pending', started_at = NULL
       WHERE status = 'processing' AND started_at < now() - ${STUCK_AFTER}`,
    );
  void sweep().catch(() => undefined); // startup sweep; DB may not be ready yet
  const sweepTimer = setInterval(() => void sweep().catch(() => undefined), STUCK_SWEEP_MS);
  sweepTimer.unref?.();

  /** Handle one claimed item: run the pipeline and record the outcome. */
  async function runClaimed(item: QueueItem): Promise<void> {
    let outcome: 'done' | 'retry' | 'failed';
    let error: unknown;
    try {
      outcome = await processItem(item, deps);
    } catch (err) {
      outcome = 'retry';
      error = err;
    }
    if (outcome === 'done') {
      await pool.query(
        `UPDATE ingest_queue SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1`,
        [item.id],
      );
      return;
    }
    // 'retry' with no thrown error still needs a message for last_error.
    const message = error instanceof Error ? error.message : `pipeline outcome: ${outcome}`;
    const lastError = redact(message);
    // attempts was already incremented by the claim.
    if (outcome === 'failed' || item.attempts >= MAX_ATTEMPTS) {
      await pool.query(
        `UPDATE ingest_queue SET status = 'failed', finished_at = now(), last_error = $2 WHERE id = $1`,
        [item.id, lastError],
      );
    } else {
      await pool.query(
        `UPDATE ingest_queue
         SET status = 'pending', started_at = NULL, last_error = $2,
             run_after = now() + make_interval(secs => $3)
         WHERE id = $1`,
        [item.id, lastError, 2 ** item.attempts],
      );
    }
  }

  async function slot(): Promise<void> {
    while (!stopping) {
      let claimed = false;
      try {
        const { rows } = await pool.query<QueueItem>(CLAIM_SQL);
        const item = rows[0];
        if (item !== undefined) {
          claimed = true;
          await runClaimed(item);
        }
      } catch {
        // claim/outcome write failed; keep polling rather than dying
      }
      if (!claimed && !stopping) await sleep(POLL_MS);
    }
  }

  for (let i = 0; i < concurrency; i += 1) slots.push(slot());

  return {
    async stop(): Promise<void> {
      stopping = true;
      clearInterval(sweepTimer);
      // Slot promises only resolve after their in-flight runClaimed completes,
      // so this drains all in-flight processItem calls.
      await Promise.allSettled(slots);
    },
  };
}
