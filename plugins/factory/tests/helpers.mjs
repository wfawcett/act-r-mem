import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, "..");
export const OPTIONS = { Backlog: "o1", Specify: "o2", "Spec Review": "o3", Ready: "o4", "In progress": "o5", "In review": "o6", Approved: "o7", Done: "o8" };

// A temp dir with a fake `gh` first on PATH and a fresh state file.
export function makeEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-test-"));
  const state = path.join(dir, "state.json");
  const byId = Object.fromEntries(Object.entries(OPTIONS).map(([name, id]) => [id, name]));
  fs.writeFileSync(state, JSON.stringify({
    calls: [], issues: {}, repoLabels: [], fieldName: "Status", options: byId,
    items: [{ id: "item-7", number: 7, stage: "Backlog" }], ...extra,
  }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, "fake-gh.mjs")}" "$@"\n`, { mode: 0o755 });
  const claudeState = path.join(dir, "claude-state.json");
  fs.writeFileSync(claudeState, JSON.stringify({ calls: [], script: [] }));
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, "fake-claude.mjs")}" "$@"\n`, { mode: 0o755 });
  const ompState = path.join(dir, "omp-state.json");
  fs.writeFileSync(ompState, JSON.stringify({ calls: [], script: [] }));
  fs.writeFileSync(path.join(bin, "omp"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, "fake-omp.mjs")}" "$@"\n`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state,
    FAKE_CLAUDE_STATE: claudeState, FACTORY_CONFIG: path.join(dir, "factory.yml"),
    OMP_STATE: ompState,
  };
  const read = () => JSON.parse(fs.readFileSync(state, "utf8"));
  const script = (name, ...args) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts", `${name}.mjs`), ...args], { env, cwd: dir, encoding: "utf8" });
  const options = Object.entries(OPTIONS).map(([k, v]) => `${k}=${v}`).join(",");
  const writeConfig = () =>
    script("setup", "config", "--repo", "acme/widgets", "--owner", "acme", "--number", "3", "--project-id", "PVT_1",
      "--field-name", "Status", "--field-id", "F1", "--options", options);
  const readClaude = () => JSON.parse(fs.readFileSync(claudeState, "utf8"));
  const claudeScript = (script) => fs.writeFileSync(claudeState, JSON.stringify({ calls: [], script }));
  const readOmp = () => JSON.parse(fs.readFileSync(ompState, "utf8"));
  const ompScript = (script) => fs.writeFileSync(ompState, JSON.stringify({ calls: [], script }));
  return { dir, env, read, script, writeConfig, readClaude, claudeScript, readOmp, ompScript, config: env.FACTORY_CONFIG };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

export const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const git = (env, cwd, ...args) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const COMMANDS = (specify, inProgress, approved) => `commands:
  Specify:
    command: "${specify}"
    model: sonnet
    max_turns: 30
    allowed_tools:
      - Read
  In progress:
    command: "${inProgress}"
    model: sonnet
    max_turns: 100
    allowed_tools:
      - Read
${approved ? `  Approved:
    command: "${approved}"
    model: sonnet
    max_turns: 10
    allowed_tools:
      - Read
` : ""}`;

// A factory env on top of makeEnv: temp HOME, a temp git repo cloned from a temp bare origin
// with factory.yml inside it, a copy of scripts/ whose run-phase.mjs is a fake, and a state file for the fake.
// opts.phase: [{ out, exit, delay, moveTo, label, hang }] by call number; opts.poll: poll_seconds.
export function makeFactory({ items, issues = {}, prs = [], deps = {}, phase = [], poll = 3600, specify = "", inProgress = "build", approved = "" }) {
  const e = makeEnv({ items, issues, prs, deps });
  e.env.HOME = path.join(e.dir, "home");
  fs.mkdirSync(e.env.HOME);
  e.env.GIT_CONFIG_GLOBAL = "/dev/null";
  const seed = path.join(e.dir, "seed");
  const origin = path.join(e.dir, "origin.git");
  e.repo = path.join(e.dir, "repo");
  fs.mkdirSync(seed);
  git(e.env, seed, "init", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(e.env, seed, "add", "README.md");
  git(e.env, seed, "commit", "-m", "seed");
  spawnSync("git", ["init", "--bare", "-b", "main", origin], { env: e.env });
  git(e.env, seed, "push", origin, "main");
  spawnSync("git", ["clone", origin, e.repo], { env: e.env });
  e.repo = fs.realpathSync(e.repo);
  e.git = (...args) => git(e.env, e.repo, ...args);
  e.originHead = git(e.env, origin, "rev-parse", "main");

  e.env.FACTORY_CONFIG = path.join(e.repo, "factory.yml");
  e.config = e.env.FACTORY_CONFIG;
  if (e.writeConfig().status !== 0) throw new Error("config not written");
  const text = fs.readFileSync(path.join(e.dir, "factory.yml"), "utf8");
  fs.writeFileSync(
    e.config,
    text.replace(/commands:[\s\S]*?\npoll_seconds: \d+/, `${COMMANDS(specify, inProgress, approved)}poll_seconds: ${poll}`),
  );

  e.scripts = path.join(e.dir, "scripts");
  fs.cpSync(path.join(ROOT, "scripts"), e.scripts, { recursive: true });
  e.phaseState = path.join(e.dir, "phase-state.json");
  fs.writeFileSync(e.phaseState, JSON.stringify({ script: phase, calls: [] }));
  e.env.FAKE_PHASE_STATE = e.phaseState;
  fs.writeFileSync(path.join(e.scripts, "run-phase.mjs"), FAKE_PHASE);
  e.phaseCalls = () => JSON.parse(fs.readFileSync(e.phaseState, "utf8")).calls;
  e.watcher = (...extra) =>
    spawnSync(process.execPath, [path.join(e.scripts, "watcher.mjs"), "--config", e.config, ...extra], {
      env: e.env, cwd: e.dir, encoding: "utf8",
    });
  e.spawnWatcher = () => {
    const child = spawn(process.execPath, [path.join(e.scripts, "watcher.mjs"), "--config", e.config], {
      env: e.env, cwd: e.dir, stdio: ["ignore", "pipe", "pipe"],
    });
    child.output = "";
    child.stdout.on("data", (d) => { child.output += d; });
    child.stderr.on("data", (d) => { child.output += d; });
    child.exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    return child;
  };
  e.ctl = (...args) => spawnSync(process.execPath, [path.join(e.scripts, "watcher-ctl.mjs"), ...args], { env: e.env, cwd: e.dir, encoding: "utf8" });
  e.pidFile = path.join(e.env.HOME, ".factory", "widgets", "watcher.pid");
  return e;
}

// Stands in for run-phase.mjs. Call N follows script[N]: delay, moveTo (a stage, written to the fake board),
// label (added to the card), hang (spawn a child and wait forever, pids go to pids.json), out, exit.
const FAKE_PHASE = `import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const file = process.env.FAKE_PHASE_STATE;
const [issue, stage] = process.argv.slice(2);
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const step = s.script[s.calls.length] ?? {};
const index = s.calls.length;
s.calls.push({ issue, stage, cwd, start: Date.now(), end: null });
fs.writeFileSync(file, JSON.stringify(s));
if (step.hang) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(path.dirname(file), "pids.json"), JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else {
  await new Promise((r) => setTimeout(r, step.delay ?? 0));
  const gh = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
  if (step.moveTo) gh.items.find((i) => String(i.number) === issue).stage = step.moveTo;
  if (step.label) (gh.issues[issue] ??= { labels: [], comments: [] }).labels.push(step.label);
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(gh));
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  after.calls[index].end = Date.now();
  fs.writeFileSync(file, JSON.stringify(after));
  console.log(step.out ?? "done #" + issue);
  process.exit(step.exit ?? 0);
}
`;
