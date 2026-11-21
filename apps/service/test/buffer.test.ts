import { describe, expect, it, vi } from 'vitest';
import { UseBuffer, type UseInput } from '../src/reinforce/buffer.js';
import type { Params } from '../src/config.js';

const params = {} as Params;
const pool = {} as never;

function makeBuffer(apply: (uses: readonly UseInput[]) => Promise<void>, opts?: object) {
  return new UseBuffer({
    pool,
    params,
    useFlushMs: 0,
    apply: (_p, _params, uses) => apply(uses),
    ...opts,
  });
}

describe('UseBuffer (E08 task 2)', () => {
  it('dedupes (traceId, nodeId) within the pending set', async () => {
    const flushed: UseInput[] = [];
    const b = makeBuffer(async (uses) => void flushed.push(...uses));
    b.add({ nodeId: 1, traceId: 7 });
    b.add({ nodeId: 1, traceId: 7 });
    b.add({ nodeId: 1 });
    expect(b.size()).toBe(2);
    await b.flush();
    expect(flushed).toHaveLength(2);
  });

  it('no flush before threshold or timer', async () => {
    const apply = vi.fn(async () => {});
    const b = makeBuffer(apply);
    b.add({ nodeId: 1 });
    expect(apply).not.toHaveBeenCalled();
    b.stop();
  });

  it('size()===threshold triggers exactly one flush', async () => {
    const flushed: UseInput[] = [];
    let resolveApply!: () => void;
    const gate = new Promise<void>((r) => (resolveApply = r));
    let released = false;
    const b = new UseBuffer({
      pool,
      params,
      useFlushMs: 0,
      sizeThreshold: 3,
      apply: async (_p, _params, uses) => {
        expect(released).toBe(false); // one batch only
        flushed.push(...uses);
        await gate; // keep inflight while further adds arrive
      },
    });
    b.add({ nodeId: 1 });
    b.add({ nodeId: 2 });
    b.add({ nodeId: 3 }); // size 3 -> flush starts
    const flushPromise = b.flush(); // pending empty; second add goes to new pending set
    b.add({ nodeId: 4, traceId: 1 });
    b.add({ nodeId: 4, traceId: 2 });
    b.add({ nodeId: 4, traceId: 3 }); // threshold again -> concurrent flush serializes
    b.add({ nodeId: 4, traceId: 4 });
    expect(b.size()).toBe(4); // new pending set untouched by the inflight batch
    released = true;
    resolveApply();
    await flushPromise;
    expect(flushed).toEqual([
      { nodeId: 1 },
      { nodeId: 2 },
      { nodeId: 3 },
    ]);
    b.stop();
  });

  it('flush() is idempotent on an empty buffer', async () => {
    const apply = vi.fn(async () => {});
    const b = makeBuffer(apply);
    await b.flush();
    expect(apply).not.toHaveBeenCalled();
  });

  it('un-flushed uses stay pending after a flush of an earlier batch', async () => {
    const flushed: UseInput[] = [];
    const b = makeBuffer(async (uses) => {
      b.add({ nodeId: 99 }); // arrives while the batch is inflight
      flushed.push(...uses);
    });
    b.add({ nodeId: 1 });
    await b.flush();
    expect(flushed).toEqual([{ nodeId: 1 }]);
    expect(b.size()).toBe(1);
  });
});
