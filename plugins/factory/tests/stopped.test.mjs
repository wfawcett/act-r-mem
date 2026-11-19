import assert from "node:assert/strict";
import test from "node:test";
import { makeEnv } from "./helpers.mjs";

const comment = (label, need, why) => ({ body: [`factory: ${label}`, `need: ${need}`, `why: ${why}`, "time: t"].join("\n") });

// AC6
test("stopped.mjs lists BLOCKED and REVIEW cards with stage and reason, and nothing else", () => {
  const e = makeEnv({
    items: [
      { id: "i1", number: 1, stage: "In progress" },
      { id: "i2", number: 2, stage: "In review" },
      { id: "i3", number: 3, stage: "Ready" },
      { id: "i4", number: 4, stage: "Done" },
    ],
    issues: {
      1: { labels: ["BLOCKED"], comments: [comment("BLOCKED", "old need", "old why"), comment("BLOCKED", "fix the build", "tests fail")] },
      2: { labels: ["REVIEW"], comments: [comment("REVIEW", "look at the diff", "large change")] },
      4: { labels: [], comments: [comment("BLOCKED", "x", "y"), { body: "factory: cleared BLOCKED\nsolution: z" }] },
    },
  });
  assert.equal(e.writeConfig().status, 0);
  const before = JSON.stringify(e.read().items);
  const r = e.script("stopped");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), [
    "#1 In progress BLOCKED need: fix the build why: tests fail",
    "#2 In review REVIEW need: look at the diff why: large change",
  ]);
  const s = e.read();
  assert.equal(JSON.stringify(s.items), before);
  assert.ok(s.calls.every((c) => !(c[0] === "issue" && ["comment", "edit"].includes(c[1])) && !(c[0] === "project" && c[1] === "item-edit")), "stopped.mjs wrote");
});

test("stopped.mjs prints nothing when no card is stopped", () => {
  const e = makeEnv();
  assert.equal(e.writeConfig().status, 0);
  const r = e.script("stopped");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});
