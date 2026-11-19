import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { alive, makeFactory, waitFor } from "./helpers.mjs";

const item = (number, stage) => ({ id: `item-${number}`, number, stage });
const pidOf = (e) => Number(fs.readFileSync(e.pidFile, "utf8"));

// Every ctl test stops the watcher in finally, then asserts every pid it saw is dead.
async function withWatcher(e, body) {
  const seen = [];
  try {
    await body(seen);
  } finally {
    e.ctl("stop");
    if (fs.existsSync(e.pidFile)) seen.push(pidOf(e));
    for (const pid of seen) await waitFor(() => !alive(pid), 5000);
  }
  for (const pid of seen) assert.ok(!alive(pid), `pid ${pid} is still alive`);
}

// AC1
test("start writes the pid, a second start starts nothing, status shows it, stop ends it", async () => {
  const e = makeFactory({ items: [item(1, "Backlog")] });
  await withWatcher(e, async (seen) => {
    assert.match(e.ctl("status").stdout, /^not running/);
    const first = e.ctl("start");
    assert.equal(first.status, 0, first.stderr);
    const pid = pidOf(e);
    seen.push(pid);
    assert.equal(first.stdout.split("\n")[0], `started, pid ${pid}`);
    assert.ok(alive(pid));
    assert.match(e.ctl("status").stdout, new RegExp(`^running, pid ${pid}\\n.*watcher\\.log`));

    const second = e.ctl("start");
    assert.equal(second.stdout.trim(), `already running, pid ${pid}`);
    assert.equal(pidOf(e), pid);

    const stop = e.ctl("stop");
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, new RegExp(`^stopped, pid ${pid}`));
    assert.ok(!fs.existsSync(e.pidFile));
    assert.ok(await waitFor(() => !alive(pid), 5000));
    assert.match(e.ctl("status").stdout, /^not running/);
    assert.equal(e.ctl("stop").stdout.trim(), "not running");
  });
});

test("a stale pid file is replaced", async () => {
  const e = makeFactory({ items: [item(1, "Backlog")] });
  await withWatcher(e, async (seen) => {
    const dead = spawn(process.execPath, ["-e", "0"]);
    await new Promise((r) => dead.on("exit", r));
    fs.mkdirSync(path.dirname(e.pidFile), { recursive: true });
    fs.writeFileSync(e.pidFile, String(dead.pid));
    seen.push(dead.pid);
    const r = e.ctl("start");
    assert.equal(r.status, 0, r.stderr);
    const pid = pidOf(e);
    seen.push(pid);
    assert.notEqual(pid, dead.pid);
    assert.match(r.stdout, new RegExp(`^started, pid ${pid}`));
    assert.ok(alive(pid));
  });
});

test("a missing or bad factory.yml makes start exit 2 with no process and no pid file", async () => {
  const e = makeFactory({ items: [item(1, "Backlog")] });
  await withWatcher(e, async () => {
    fs.renameSync(e.config, `${e.config}.moved`);
    const missing = e.ctl("start");
    assert.equal(missing.status, 2, missing.stderr);
    assert.ok(!fs.existsSync(e.pidFile));

    fs.writeFileSync(e.config, "");
    const empty = e.ctl("start");
    assert.equal(empty.status, 2, empty.stderr);
    assert.ok(!fs.existsSync(e.pidFile));

    fs.writeFileSync(e.config, "board:\n  repo: not-a-repo\n");
    const bad = e.ctl("start");
    assert.equal(bad.status, 2, bad.stderr);
    assert.ok(!fs.existsSync(e.pidFile));
  });
});

test("stop while a phase runs ends the watcher, run-phase and its child", async () => {
  const e = makeFactory({ items: [item(7, "In progress")], phase: [{ hang: true }] });
  const pidsFile = path.join(e.dir, "pids.json");
  await withWatcher(e, async (seen) => {
    assert.equal(e.ctl("start").status, 0);
    seen.push(pidOf(e));
    const ready = () => {
      try { return JSON.parse(fs.readFileSync(pidsFile, "utf8")).length === 2; } catch { return false; }
    };
    assert.ok(await waitFor(ready), "fake run-phase never started");
    const phasePids = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
    seen.push(...phasePids);
    for (const pid of seen) assert.ok(alive(pid));
    const stop = e.ctl("stop");
    assert.equal(stop.status, 0, stop.stderr);
    for (const pid of seen) assert.ok(await waitFor(() => !alive(pid), 5000), `pid ${pid} survived stop`);
  });
});
