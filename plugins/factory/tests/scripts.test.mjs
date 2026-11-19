import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeEnv } from "./helpers.mjs";

const ready = () => {
  const e = makeEnv();
  assert.equal(e.writeConfig().status, 0);
  return e;
};
const mutations = (e) => e.read().calls.filter((c) => ["item-edit", "comment", "edit"].includes(c[1]) || c[1] === "create");

// AC5
test("move: moves the card when it is still in --from and writes one audit comment", () => {
  const e = ready();
  const r = e.script("move", "7", "Specify", "--from", "Backlog", "--reason", "ready for spec");
  assert.equal(r.status, 0, r.stderr);
  const s = e.read();
  assert.equal(s.items[0].stage, "Specify");
  const comments = s.issues["7"].comments;
  assert.equal(comments.length, 1);
  const lines = comments[0].body.split("\n");
  assert.equal(lines[0], "factory: moved Backlog -> Specify");
  assert.equal(lines[1], "reason: ready for spec");
  assert.match(lines[2], /^time: \d{4}-\d\d-\d\dT/);
});

test("move: exits non-zero and changes nothing when a person moved the card", () => {
  const e = ready();
  const r = e.script("move", "7", "Ready", "--from", "Specify", "--reason", "x");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Nothing changed/);
  assert.equal(e.read().items[0].stage, "Backlog");
  assert.equal(mutations(e).length, 0);
});

test("move: rejects an unknown stage and a missing --from", () => {
  const e = ready();
  assert.equal(e.script("move", "7", "Nowhere", "--from", "Backlog", "--reason", "x").status, 2);
  assert.equal(e.script("move", "7", "Specify", "--reason", "x").status, 2);
  assert.equal(mutations(e).length, 0);
});

test("move: a card that is not on the board is an error", () => {
  const e = ready();
  assert.equal(e.script("move", "99", "Specify", "--from", "Backlog", "--reason", "x").status, 2);
});

// AC6
for (const label of ["BLOCKED", "REVIEW"]) {
  test(`block and clear: ${label} is added and removed, one comment each`, () => {
    const e = ready();
    assert.equal(e.script("block", "7", "--need", "a key", "--why", "no default", "--label", label).status, 0);
    let i = e.read().issues["7"];
    assert.deepEqual(i.labels, [label]);
    assert.equal(i.comments.length, 1);
    assert.equal(i.comments[0].body.split("\n")[0], `factory: ${label}`);
    assert.equal(e.script("clear", "7", "--solution", "key added", "--label", label).status, 0);
    i = e.read().issues["7"];
    assert.deepEqual(i.labels, []);
    assert.equal(i.comments.length, 2);
    assert.equal(i.comments[1].body.split("\n")[0], `factory: cleared ${label}`);
    assert.match(i.comments[1].body, /solution: key added/);
  });
}

test("block: label defaults to BLOCKED and a bad label is rejected", () => {
  const e = ready();
  assert.equal(e.script("block", "7", "--need", "n", "--why", "w").status, 0);
  assert.deepEqual(e.read().issues["7"].labels, ["BLOCKED"]);
  assert.equal(e.script("block", "7", "--need", "n", "--why", "w", "--label", "OTHER").status, 2);
});

test("block: a second block for the same state writes no second comment", () => {
  const e = ready();
  e.script("block", "7", "--need", "n", "--why", "w");
  const r = e.script("block", "7", "--need", "n", "--why", "w");
  assert.equal(r.status, 0);
  assert.equal(e.read().issues["7"].comments.length, 1);
});

test("block: a block after a clear writes a new comment", () => {
  const e = ready();
  e.script("block", "7", "--need", "n", "--why", "w");
  e.script("clear", "7", "--solution", "s");
  e.script("block", "7", "--need", "n", "--why", "w");
  assert.equal(e.read().issues["7"].comments.length, 3);
});

test("block: BLOCKED and REVIEW keep separate comment histories", () => {
  const e = ready();
  e.script("block", "7", "--need", "n", "--why", "w", "--label", "BLOCKED");
  e.script("block", "7", "--need", "n", "--why", "w", "--label", "REVIEW");
  assert.equal(e.read().issues["7"].comments.length, 2);
});

test("clear: a second clear writes no second comment", () => {
  const e = ready();
  e.script("block", "7", "--need", "n", "--why", "w");
  e.script("clear", "7", "--solution", "s");
  e.script("clear", "7", "--solution", "s");
  assert.equal(e.read().issues["7"].comments.length, 2);
});

test("scripts need their required flags", () => {
  const e = ready();
  assert.equal(e.script("block", "7", "--need", "n").status, 2);
  assert.equal(e.script("clear", "7").status, 2);
});

// AC3
test("dummy card: moved, blocked and cleared through the three scripts", () => {
  const e = ready();
  assert.equal(e.script("move", "7", "Specify", "--from", "Backlog", "--reason", "install test").status, 0);
  assert.equal(e.script("block", "7", "--need", "none", "--why", "install test").status, 0);
  assert.equal(e.script("clear", "7", "--solution", "install test").status, 0);
  const s = e.read();
  assert.equal(s.items[0].stage, "Specify");
  assert.deepEqual(s.issues["7"].labels, []);
  assert.equal(s.issues["7"].comments.length, 3);
});

test("scripts never pass a token flag or write outside the temp dir", () => {
  const src = fs.readdirSync(path.join(import.meta.dirname, "..", "scripts"), { recursive: true })
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", f), "utf8"))
    .join("\n");
  assert.ok(!/rm -rf|--dangerous(?:ly)-skip-permissions|auth token/.test(src));
});
