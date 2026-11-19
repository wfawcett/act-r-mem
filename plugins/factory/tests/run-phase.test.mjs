import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeEnv, ROOT } from "./helpers.mjs";

const COMMANDS = `commands:
  In progress:
    command: /team:build
    model: sonnet
    max_turns: 100
    allowed_tools:
      - Read
      - Bash(git *)
  Specify:
    command: ""
    model: sonnet
    max_turns: 30
    allowed_tools:
      - Read
`;

// A temp env with card 7 in "In progress", a worktree dir, and a factory.yml whose commands block is COMMANDS.
function ready(commands = COMMANDS, stage = "In progress") {
  const e = makeEnv({ items: [{ id: "item-7", number: 7, stage }] });
  assert.equal(e.writeConfig().status, 0);
  const text = fs.readFileSync(e.config, "utf8");
  fs.writeFileSync(e.config, text.replace(/commands:[\s\S]*?\npoll_seconds/, `${commands}poll_seconds`));
  e.wt = path.join(e.dir, "wt");
  fs.mkdirSync(e.wt);
  e.stageDir = path.join(e.wt, ".tmp", "factory", "7", "in-progress");
  e.resultFile = path.join(e.stageDir, "result.json");
  e.attempts = path.join(e.stageDir, "attempts");
  e.phase = (...extra) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts", "run-phase.mjs"), "7", "In progress", "--cwd", e.wt, ...extra], {
      env: e.env, cwd: e.dir, encoding: "utf8",
    });
  return e;
}
const json = (o) => JSON.stringify(o);
const argv_model = (argv) => argv[argv.indexOf("--model") + 1];
const mutations = (e) => e.read().calls.filter((c) => ["item-edit", "comment", "edit"].includes(c[1]));

// The omp runner: one headless parent per stage attempt. Assert the flag vector and prompt.
test("run-phase: starts omp with the required arguments and cwd", () => {
  const e = ready();
  e.ompScript([{ result: json({ status: "done" }) }]);
  const r = e.phase();
  assert.equal(r.status, 0, r.stderr);
  const [{ argv, cwd }] = e.readOmp().calls;
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(e.wt));
  assert.equal(argv[0], "-p");
  const prompt = argv[1];
  assert.match(prompt, /^\/team:build$/m);
  assert.match(prompt, /^Card: #7\. Stage: In progress\.$/m);
  assert.match(prompt, new RegExp(`^Result file: ${e.resultFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(prompt, /Delegate this assignment to the `progress-agent` agent/);
  const i = (f) => argv.indexOf(f);
  assert.ok(i("--system-prompt") > 0);
  const contract = argv[i("--system-prompt") + 1];
  assert.match(contract, /delegate the assignment .* to the named agent via the `task`/is);
  assert.equal(argv_model(argv), "@default"); // config-level models map (template) wins over the stage's model: string
  // max_turns 100 -> wall-clock ceiling 100 * 120s, clamped to >= 600.
  assert.equal(argv[i("--max-time") + 1], "12000");
  assert.equal(argv[i("--tools") + 1], "task");
  for (const f of ["--auto-approve", "--wait-async", "--mode", "json"]) assert.ok(argv.includes(f), `argv has ${f}`);
  assert.ok(!argv.some((a) => a.includes("dangerously")));
});

test("run-phase: config-level models map wins when the stage has no models block", () => {
  const e = ready();
  e.ompScript([{ result: json({ status: "done" }) }]);
  assert.equal(e.phase().status, 0);
  assert.equal(argv_model(e.readOmp().calls[0].argv), "@default");
});

test("run-phase: per-stage models override the config-level map", () => {
  const e = ready();
  const c2 = COMMANDS.replace("model: sonnet", "models:\n      omp: qwen3.8-27b-gsq-rco");
  fs.writeFileSync(e.config, fs.readFileSync(e.config, "utf8").replace(/commands:[\s\S]*?\npoll_seconds/, `${c2}poll_seconds`));
  e.ompScript([{ result: json({ status: "done" }) }]);
  assert.equal(e.phase().status, 0);
  assert.equal(argv_model(e.readOmp().calls[0].argv), "qwen3.8-27b-gsq-rco");
});

test("run-phase: --config is forwarded to the child scripts", () => {
  const e = ready();
  const alt = path.join(e.dir, "alt.yml");
  fs.copyFileSync(e.config, alt);
  fs.unlinkSync(e.config);
  e.ompScript([{ result: json({ status: "done" }) }]);
  const r = e.phase("--config", alt);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(e.read().items[0].stage, "In review");
});

test("repo: no skip-permissions flag in scripts, agents, commands; no design or build plugin names", () => {
  const skip = ["dangerously", "skip-permissions"].join("-");
  const names = [["engineering", "design"].join("-"), ["engineering", "build"].join("-")];
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(d, f.name)) : [path.join(d, f.name)]));
  for (const dir of ["scripts", "agents", "commands", "tests"]) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of walk(full)) {
      const text = fs.readFileSync(f, "utf8");
      if (dir !== "tests") assert.ok(!text.includes(skip), `${f} holds the skip-permissions flag`);
      for (const n of names) assert.ok(!text.includes(n), `${f} names ${n}`);
    }
  }
});

// AC3
test("run-phase: done moves the card, writes one audit comment, clears the count", () => {
  const e = ready();
  e.ompScript([{ exit: 1 }, { result: json({ status: "done" }) }]);
  assert.match(e.phase().stdout, /^retry/);
  assert.equal(fs.readFileSync(e.attempts, "utf8").trim(), "1");
  const r = e.phase();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^done/);
  const s = e.read();
  assert.equal(s.items[0].stage, "In review");
  assert.equal(s.issues["7"].comments.length, 3);
  assert.match(s.issues["7"].comments[0].body, /^\u{1f3ed} Build report — In progress stage \u00b7 #7/u);
  assert.match(s.issues["7"].comments[1].body, /failed .* omp exited 1|done . In progress/);
  assert.equal(s.issues["7"].comments[2].body.split("\n")[0], "factory: moved In progress -> In review");
  assert.ok(!fs.existsSync(e.attempts));
});

test("run-phase: done exits 3 and writes nothing when a person moved the card", () => {
  const e = ready(COMMANDS, "Approved");
  e.ompScript([{ result: json({ status: "done" }) }]);
  const r = e.phase();
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^moved #7/);
  // The build report posts before the move check sees the person's move.
  assert.deepEqual(mutations(e).map((c) => c[1]), ["comment"]);
  assert.match(e.read().issues["7"].comments[0].body, /^\u{1f3ed}/u);
  assert.equal(e.read().items[0].stage, "Approved");
});

test("run-phase: a failed move.mjs keeps the count and exits 1", () => {
  const e = ready();
  fs.mkdirSync(e.stageDir, { recursive: true });
  fs.writeFileSync(e.attempts, "1");
  e.ompScript([{ result: json({ status: "done" }) }]);
  const s = e.read();
  fs.writeFileSync(e.env.FAKE_GH_STATE, JSON.stringify({ ...s, fail: ["project item-edit"] }));
  const r = e.phase();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^error #7/);
  assert.equal(e.read().calls.filter((c) => c[1] === "comment").length, 1); // build report posted before move failed
  assert.equal(fs.readFileSync(e.attempts, "utf8").trim(), "1");
});

// AC4
test("run-phase: blocked labels the card with one one-line need and keeps the stage", () => {
  const e = ready();
  e.ompScript([{ result: json({ status: "blocked", need: "add the\nAPI key", recommended: "use\nthe sandbox key" }) }]);
  const r = e.phase();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^blocked/);
  const s = e.read();
  assert.equal(s.items[0].stage, "In progress");
  assert.deepEqual(s.issues["7"].labels, ["BLOCKED"]);
  assert.equal(s.issues["7"].comments.length, 2);
  const lines = s.issues["7"].comments[1].body.split("\n");
  assert.equal(lines[0], "factory: BLOCKED");
  assert.equal(lines[1], "need: add the API key");
  assert.equal(lines[2], "why: In progress phase blocked. Recommended: use the sandbox key");
  assert.ok(!fs.existsSync(e.attempts));
});

test("run-phase: blocked with no recommended says none", () => {
  const e = ready();
  e.ompScript([{ result: json({ status: "blocked", need: "decide X" }) }]);
  assert.equal(e.phase().status, 0);
  assert.match(e.read().issues["7"].comments[1].body, /Recommended: none/);
});

// AC5
test("run-phase: two failed attempts block the card, then a done run starts at zero", () => {
  const e = ready();
  e.ompScript([{ exit: 1 }, { result: json({ status: "failed", need: "build gate red" }) }, { result: json({ status: "done" }) }]);
  const r1 = e.phase();
  assert.equal(r1.status, 0);
  assert.match(r1.stdout, /^retry/);
  assert.deepEqual(e.read().issues["7"]?.labels ?? [], []);
  const r2 = e.phase();
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /^blocked/);
  const s = e.read();
  assert.deepEqual(s.issues["7"].labels, ["BLOCKED"]);
  assert.equal(s.issues["7"].comments.length, 3);
  assert.match(s.issues["7"].comments[2].body, /failed 2 times\. Last reason: build gate red/);
  assert.match(s.issues["7"].comments[2].body, /worker\.log/);
  assert.ok(!fs.existsSync(e.attempts));
  assert.equal(e.phase().status, 0);
  assert.equal(e.read().items[0].stage, "In review");
});

test("run-phase: a stale result.json is never read as new", () => {
  const e = ready();
  fs.mkdirSync(e.stageDir, { recursive: true });
  fs.writeFileSync(e.resultFile, json({ status: "done" }));
  e.ompScript([{}]);
  const r = e.phase();
  assert.match(r.stdout, /^retry/);
  assert.equal(e.read().items[0].stage, "In progress");
});

test("run-phase: a failed block at the cap keeps the count and the next call blocks without omp", () => {
  const e = ready();
  fs.mkdirSync(e.stageDir, { recursive: true });
  fs.writeFileSync(e.attempts, "1");
  e.ompScript([{ exit: 1 }]);
  fs.writeFileSync(e.env.FAKE_GH_STATE, JSON.stringify({ ...e.read(), fail: ["issue view"] }));
  const r = e.phase();
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(e.attempts, "utf8").trim(), "2");
  fs.writeFileSync(e.env.FAKE_GH_STATE, JSON.stringify({ ...e.read(), fail: [] }));
  const r2 = e.phase();
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /^blocked/);
  assert.equal(e.readOmp().calls.length, 1);
  assert.ok(!fs.existsSync(e.attempts));
});

test("run-phase: a missing or non-integer count file reads as zero", () => {
  const e = ready();
  fs.mkdirSync(e.stageDir, { recursive: true });
  fs.writeFileSync(e.attempts, "banana");
  e.ompScript([{ exit: 1 }]);
  assert.match(e.phase().stdout, /^retry/);
  assert.equal(fs.readFileSync(e.attempts, "utf8").trim(), "1");
});

// AC6
const INVALID = {
  "non-zero exit": { exit: 2, result: json({ status: "done" }) },
  "no result.json": {},
  "invalid JSON": { result: "{nope" },
  "JSON null": { result: "null" },
  "unknown status": { result: json({ status: "maybe" }) },
  "blocked with empty need": { result: json({ status: "blocked", need: "  " }) },
};
for (const [name, step] of Object.entries(INVALID)) {
  test(`run-phase: ${name} counts as one failed attempt`, () => {
    const e = ready();
    e.ompScript([step]);
    const r = e.phase();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^retry/);
    assert.equal(fs.readFileSync(e.attempts, "utf8").trim(), "1");
    assert.equal(e.read().items[0].stage, "In progress");
    assert.deepEqual(mutations(e).map((c) => c[1]), ["comment"]); // only the failure report
  });
}

test("run-phase: the retry line names the real reason for invalid JSON", () => {
  const e = ready();
  e.ompScript([{ result: "{nope" }]);
  assert.match(e.phase().stdout, /result\.json is not valid JSON/);
});

// AC7
const bad = {
  "empty command": COMMANDS.replace("command: /team:build", 'command: ""'),
  "no allowed_tools": COMMANDS.replace(/    allowed_tools:\n(      - .*\n)+/, ""),
  "no command key": COMMANDS.replace("    command: /team:build\n", ""),
  "no model": COMMANDS.replace("    model: sonnet\n    max_turns: 100", "    max_turns: 100"),
  "no max_turns": COMMANDS.replace("    max_turns: 100\n", ""),
};
for (const [name, commands] of Object.entries(bad)) {
  test(`run-phase: ${name} exits 2 and spawns nothing`, () => {
    const e = ready(commands);
    e.ompScript([{ result: json({ status: "done" }) }]);
    const r = e.phase();
    assert.equal(r.status, 2, r.stderr);
    assert.equal(e.readOmp().calls.length, 0);
    assert.equal(mutations(e).length, 0);
  });
}

test("run-phase: a stage in stages with no commands entry exits 2 and spawns nothing", () => {
  const e = ready(COMMANDS, "Spec Review");
  e.ompScript([{}]);
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "run-phase.mjs"), "7", "Spec Review", "--cwd", e.wt], { env: e.env, cwd: e.dir, encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(e.readOmp().calls.length, 0);
});

test("run-phase: a non-numeric issue exits 2", () => {
  const e = ready();
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "run-phase.mjs"), "../x", "In progress", "--cwd", e.wt], { env: e.env, cwd: e.dir, encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("run-phase: unknown stage, last stage, missing --cwd and missing config exit 2", () => {
  const e = ready();
  e.ompScript([{}]);
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "run-phase.mjs"), ...a], { env: e.env, cwd: e.dir, encoding: "utf8" });
  assert.equal(run("7", "Nowhere", "--cwd", e.wt).status, 2);
  assert.equal(run("7", "Done", "--cwd", e.wt).status, 2);
  assert.equal(run("7", "In progress", "--cwd", path.join(e.dir, "nope")).status, 2);
  assert.equal(run("7", "In progress").status, 2);
  assert.equal(run("7", "In progress", "--cwd", e.wt, "--config", path.join(e.dir, "none.yml")).status, 2);
  assert.equal(e.readOmp().calls.length, 0);
  assert.equal(mutations(e).length, 0);
});
