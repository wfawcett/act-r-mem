import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeFactory, ROOT, waitFor, sleep } from "./helpers.mjs";

const item = (number, stage) => ({ id: `item-${number}`, number, stage });
const stageOf = (e, n) => e.read().items.find((i) => i.number === n).stage;

// Runs a non-once watcher, stops it with SIGTERM in finally.
async function loop(e, until, extraMs = 0) {
  const w = e.spawnWatcher();
  try {
    assert.ok(await waitFor(until), `condition not met. Watcher output:\n${w.output}`);
    await sleep(extraMs);
  } finally {
    w.kill("SIGTERM");
    await w.exited;
  }
  return w;
}

// AC2
test("skips BLOCKED and REVIEW cards, Backlog, Done and stages with no command", () => {
  const e = makeFactory({
    items: [item(1, "Backlog"), item(2, "In progress"), item(3, "In progress"), item(4, "Done"), item(5, "Spec Review"), item(6, "Specify"), item(8, "In progress")],
    deps: { "blocked_by/1": [9] }, // card 1 stays in Backlog: it has an open blocker
    issues: { 2: { labels: ["BLOCKED"], comments: [] }, 3: { labels: ["REVIEW"], comments: [] }, 6: { labels: ["BLOCKED"], comments: [] } },
    phase: [{ moveTo: "In review" }],
    specify: "spec",
  });
  const r = e.watcher("--once");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(e.phaseCalls().map((c) => c.issue), ["8"]);
});

// AC3
test("runs one card at a time: the second run starts after the first exits", async () => {
  const e = makeFactory({
    items: [item(7, "In progress"), item(8, "In progress")],
    phase: [{ delay: 400, moveTo: "In review" }, { moveTo: "In review" }],
  });
  await loop(e, () => e.phaseCalls().length === 2 && e.phaseCalls()[1].end);
  const [one, two] = e.phaseCalls();
  assert.deepEqual([one.issue, two.issue], ["7", "8"]);
  assert.ok(two.start >= one.end, "second phase started before the first one ended");
});

// AC4
test("a merged PR that closes the card moves it to Done, clears REVIEW, and #70 does not match #7", () => {
  const e = makeFactory({
    items: [item(7, "In review"), item(8, "In review"), item(9, "In review"), item(10, "In review")],
    issues: { 9: { labels: ["REVIEW"], comments: [] } },
    prs: [
      { number: 100, body: "Closes #70", merged: true },
      { number: 101, body: "Summary\n\nCloses #8", merged: true },
      { number: 102, body: "resolves #9", merged: true },
      { number: 103, body: "Fixes #10", merged: false },
    ],
  });
  const r = e.watcher("--once");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stageOf(e, 7), "In review");
  assert.equal(stageOf(e, 8), "Done");
  assert.equal(stageOf(e, 9), "Done");
  assert.equal(stageOf(e, 10), "In review");
  const s = e.read();
  assert.equal(s.issues[8].comments.filter((c) => c.body.startsWith("factory: moved In review -> Done")).length, 1);
  assert.match(s.issues[8].comments[0].body, /reason: PR merged/);
  assert.deepEqual(s.issues[9].labels, []);
  assert.equal(e.phaseCalls().length, 0);
  assert.ok(s.calls.some((c) => c[0] === "pr" && c.includes("--repo") && c.includes("acme/widgets") && c.includes("merged")));
});

test("a merged card goes to Approved when Approved has a command", () => {
  const e = makeFactory({
    items: [item(8, "In review")],
    prs: [{ number: 101, body: "Closes #8", merged: true }],
    approved: "validate",
    phase: [{ moveTo: "Done" }],
  });
  const r = e.watcher("--once");
  assert.equal(r.status, 0, r.stderr);
  const moved = e.read().issues[8].comments[0].body;
  assert.match(moved, /^factory: moved In review -> Approved/);
  assert.deepEqual(e.phaseCalls().map((c) => c.stage), ["Approved"]);
});

test("a BLOCKED card in In review is not merge-checked", () => {
  const e = makeFactory({
    items: [item(8, "In review")],
    issues: { 8: { labels: ["BLOCKED"], comments: [] } },
    prs: [{ number: 101, body: "Closes #8", merged: true }],
  });
  assert.equal(e.watcher("--once").status, 0);
  assert.equal(stageOf(e, 8), "In review");
});

// AC5
test("calls run-phase again after retry, not after blocked, and keeps no count", async () => {
  const e = makeFactory({
    items: [item(7, "In progress")],
    phase: [{ out: "retry #7: In progress attempt 1 of 2 failed (x)" }, { out: "blocked #7: In progress failed 2 times", label: "BLOCKED" }],
  });
  await loop(e, () => e.phaseCalls().length === 2 && e.phaseCalls()[1].end, 700);
  const calls = e.phaseCalls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => [c.issue, c.stage]), [["7", "In progress"], ["7", "In progress"]]);
  assert.ok(!/retry|attempts\b|attempt file/i.test(fs.readFileSync(path.join(ROOT, "scripts", "watcher.mjs"), "utf8").replace(/Keeps no attempt count/g, "")), "watcher mentions a retry count");
});

for (const code of [1, 2]) {
  test(`run-phase exit ${code}: --once logs one line and exits 0, the loop sleeps`, async () => {
    const e = makeFactory({ items: [item(7, "In progress")], phase: [{ exit: code, out: "error" }, { exit: code }, { exit: code }] });
    const r = e.watcher("--once");
    assert.equal(r.status, 0);
    assert.equal(r.stdout.split("\n").filter((l) => l.includes("run-phase exit")).length, 1);
    assert.match(r.stdout, new RegExp(`run-phase exit ${code}`));
    const f = makeFactory({ items: [item(7, "In progress")], phase: [{ exit: code }, { exit: code }, { exit: code }] });
    await loop(f, () => f.phaseCalls().length === 1 && f.phaseCalls()[0].end, 800);
    assert.equal(f.phaseCalls().length, 1, "watcher re-polled at once instead of sleeping");
  });
}

for (const code of [0, 3]) {
  test(`run-phase exit ${code}: the next poll starts at once and the card is not an error`, async () => {
    const e = makeFactory({ items: [item(7, "In progress")], phase: [{ exit: code }, { exit: code }] });
    const w = await loop(e, () => e.phaseCalls().length >= 2);
    assert.ok(e.phaseCalls().length >= 2);
    assert.ok(!/poll failed/.test(w.output));
  });
}

// AC10
test("creates the worktree on factory/<n> from origin/<default>, reuses it, re-adds it when the folder is gone", () => {
  const e = makeFactory({ items: [item(7, "In progress")], phase: [{}, {}, {}] });
  const wt = path.join(e.repo, ".tmp", "factory-worktrees", "7");
  assert.equal(e.watcher("--once").status, 0);
  assert.equal(e.phaseCalls()[0].cwd, wt);
  assert.equal(e.git("-C", wt, "rev-parse", "--abbrev-ref", "HEAD"), "factory/7");
  assert.equal(e.git("-C", wt, "rev-parse", "HEAD"), e.originHead);

  fs.writeFileSync(path.join(wt, "marker"), "kept");
  assert.equal(e.watcher("--once").status, 0);
  assert.equal(e.phaseCalls()[1].cwd, wt);
  assert.equal(fs.readFileSync(path.join(wt, "marker"), "utf8"), "kept");
  assert.equal(e.git("worktree", "list").split("\n").length, 2);

  fs.rmSync(wt, { recursive: true });
  assert.equal(e.watcher("--once").status, 0);
  assert.equal(e.phaseCalls()[2].cwd, wt);
  assert.equal(e.git("-C", wt, "rev-parse", "--abbrev-ref", "HEAD"), "factory/7");
  assert.ok(fs.existsSync(wt));
});
