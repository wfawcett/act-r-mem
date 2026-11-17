#!/usr/bin/env node
// watcher.mjs [--config <path>] [--once]
// Runs the board with nobody present, one card at a time, by calling run-phase.mjs.
// Keeps no attempt count: run-phase.mjs owns the cap. Never merges. Never skips permission checks.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gh, loadConfig, parseArgs, stamp, UsageError } from "./lib/common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (line) => console.log(`${stamp()} ${line}`);
const once = process.argv.includes("--once");

let stopping = false;
let phase = null;
let wake = null;

// SIGTERM: forward it to the running phase (its whole process group, so the worker dies too), wait, then exit.
process.on("SIGTERM", () => {
  stopping = true;
  if (phase) {
    try { process.kill(-phase.pid, "SIGTERM"); } catch { phase.kill("SIGTERM"); }
  }
  if (wake) wake();
});

const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  wake = () => { clearTimeout(t); resolve(); };
});

const script = (name, args, config) =>
  spawnSync(process.execPath, [path.join(HERE, name), ...args, "--config", config], { encoding: "utf8", env: process.env });

const git = (cwd, args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

function cards(config) {
  const { board } = config;
  const { items } = JSON.parse(
    gh(["project", "item-list", String(board.project_number), "--owner", board.owner, "--format", "json", "--limit", "500"]),
  );
  return items.filter((i) => i.content?.number).map((i) => ({
    number: i.content.number,
    stage: i[board.field_name.toLowerCase()],
    labels: i.labels ?? [],
  }));
}

// Issue state and open-blocker count in one REST call. The count is GitHub's native
// issue-dependency summary (open blockers only).
function blockerInfo(repo, issue) {
  const [state, blocked] = gh([
    "api", `repos/${repo}/issues/${issue}`,
    "--jq", "[.state, .issue_dependencies_summary.blocked_by] | join(\" \")",
  ]).trim().split(" ");
  const count = Number(blocked);
  return { state, blocked: Number.isFinite(count) ? count : 0 };
}

// Open issues this issue blocks (its dependents), with their labels.
function openDependents(repo, issue) {
  try {
    return JSON.parse(gh([
      "api", `repos/${repo}/issues/${issue}/dependencies/blocking`,
      "--jq", '[.[] | select(.state == "open") | {number, labels: [.labels[].name]}]',
    ]));
  } catch {
    return [];
  }
}

// Open issues that block this issue (its blockers), as numbers.
function openBlockerNumbers(repo, issue) {
  return JSON.parse(gh([
    "api", `repos/${repo}/issues/${issue}/dependencies/blocked_by`,
    "--jq", '[.[] | select(.state == "open") | .number]',
  ]));
}

// merge.auto: true -> the watcher merges the closing PR of an In review card itself.
function autoMerge(config, list) {
  if (!config.merge?.auto) return;
  const { board } = config;
  for (const card of list) {
    if (card.stage !== "In review" || card.labels.includes("BLOCKED")) continue;
    const prs = JSON.parse(gh(["pr", "list", "--repo", board.repo, "--state", "open", "--search", `${card.number} in:body`, "--json", "number,body"]));
    const closes = new RegExp(`\\b(closes|fixes|resolves)\\s+#${card.number}\\b`, "i");
    for (const pr of prs) {
      if (!closes.test(pr.body ?? "")) continue;
      const r = spawnSync("gh", ["pr", "merge", String(pr.number), "--repo", board.repo, "--squash"], { encoding: "utf8", env: process.env });
      log(r.status === 0
        ? `#${card.number}: auto-merged PR #${pr.number} (merge.auto)`
        : `#${card.number}: auto-merge of PR #${pr.number} failed: ${(r.stderr ?? "").split("\n")[0]}`);
    }
  }
}

// Cascade BLOCKED to the open dependents of a newly blocked card, and clear it from
// dependents whose blockers are all clear again. Only cascade-made labels are cleared:
// the cascade block comment says "need: cascade:", a worker block never does.
function cascade(config, configPath, list, prev) {
  const { board } = config;
  const now = new Set(list.filter((c) => c.labels.includes("BLOCKED")).map((c) => c.number));
  for (const n of now) {
    if (prev.has(n)) continue;
    for (const d of openDependents(board.repo, n)) {
      if (d.labels.includes("BLOCKED")) continue;
      script("block.mjs", [String(d.number), "--need", `cascade: blocked by #${n}`, "--why", `#${n} is BLOCKED; this ticket waits for it`], configPath);
      log(`#${d.number}: cascade BLOCKED (blocker #${n})`);
    }
  }
  for (const n of prev) {
    if (now.has(n)) continue;
    for (const d of openDependents(board.repo, n)) {
      if (!d.labels.includes("BLOCKED")) continue;
      const comments = JSON.parse(gh(["issue", "view", String(d.number), "--repo", board.repo, "--json", "comments"])).comments;
      const last = comments.map((c) => c.body).filter((b) => b.startsWith("factory: BLOCKED")).at(-1) ?? "";
      if (!/^need: cascade:/m.test(last)) continue;
      if (openBlockerNumbers(board.repo, d.number).some((b) => now.has(b))) continue;
      script("clear.mjs", [String(d.number), "--solution", `cascade cleared: #${n} unblocked`], configPath);
      log(`#${d.number}: cascade cleared (blocker #${n})`);
    }
  }
  return now;
}

// Promote the frontier: open Backlog cards with no open blockers move to Ready.
// to-tickets tickets arrive pre-specified, so Ready (planning) is the entry stage.
function promoteFrontier(config, configPath, list) {
  const { board } = config;
  const target = config.commands?.Ready ? "Ready" : config.stages.find((s) => s !== "Backlog" && config.commands?.[s]?.command);
  if (!target) return;
  for (const card of list) {
    if (card.stage !== "Backlog" || card.labels.includes("BLOCKED")) continue;
    const { state, blocked } = blockerInfo(board.repo, card.number);
    if (state !== "open" || blocked > 0) continue;
    const moved = script("move.mjs", [String(card.number), target, "--from", "Backlog", "--reason", "frontier: no open blockers"], configPath);
    if (moved.status === 0) log(`#${card.number}: Backlog -> ${target} (frontier)`);
  }
}

// A card in "In review" whose closing PR is merged moves on. A person merges; the watcher only notices.
function checkMerges(config, configPath, list) {
  const { board } = config;
  const target = config.stages.includes("Approved") && config.commands?.Approved?.command ? "Approved" : "Done";
  for (const card of list) {
    if (card.stage !== "In review" || card.labels.includes("BLOCKED")) continue;
    const prs = JSON.parse(
      gh(["pr", "list", "--repo", board.repo, "--state", "merged", "--search", `${card.number} in:body`, "--json", "number,body"]),
    );
    const closes = new RegExp(`\\b(closes|fixes|resolves)\\s+#${card.number}\\b`, "i");
    if (!prs.some((p) => closes.test(p.body ?? ""))) continue;
    const moved = script("move.mjs", [String(card.number), target, "--from", "In review", "--reason", "PR merged"], configPath);
    if (moved.status !== 0) {
      log(`#${card.number}: move to ${target} not done (exit ${moved.status})`);
      continue;
    }
    log(`#${card.number}: PR merged, moved to ${target}`);
    if (card.labels.includes("REVIEW")) script("clear.mjs", [String(card.number), "--label", "REVIEW", "--solution", "PR merged"], configPath);
  }
}

// <repo root>/.tmp/factory-worktrees/<n> on branch factory/<n>, made once and reused.
function ensureWorktree(configPath, n) {
  const root = git(path.dirname(configPath), ["rev-parse", "--show-toplevel"]);
  const wt = path.join(root, ".tmp", "factory-worktrees", String(n));
  if (fs.existsSync(wt)) return wt;
  git(root, ["fetch", "origin"]);
  git(root, ["worktree", "prune"]);
  const branch = `factory/${n}`;
  const exists = spawnSync("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
  if (exists) git(root, ["worktree", "add", wt, branch]);
  else git(root, ["worktree", "add", "-b", branch, wt, git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])]);
  return wt;
}

const runPhase = (n, stage, wt, configPath) => new Promise((resolve) => {
  phase = spawn(process.execPath, [path.join(HERE, "run-phase.mjs"), String(n), stage, "--cwd", wt, "--config", configPath], {
    detached: true, stdio: ["ignore", "pipe", "inherit"], env: process.env,
  });
  let out = "";
  phase.stdout.on("data", (d) => { out += d; });
  phase.on("error", (e) => { phase = null; resolve({ code: 1, out: e.message }); });
  phase.on("close", (code) => { phase = null; resolve({ code, out }); });
});

// One poll. Returns true when the next poll should start at once (run-phase exit 0 or 3).
let prevBlocked = new Set(); // card numbers BLOCKED on the previous poll; cascade's input/output.
async function poll(config, configPath) {
  const list = cards(config);
  let card;
  try {
    autoMerge(config, list);
    prevBlocked = cascade(config, configPath, list, prevBlocked);
    promoteFrontier(config, configPath, list);
    checkMerges(config, configPath, list);
    card = list.find(
      (c) => config.commands?.[c.stage]?.command && !c.labels.includes("BLOCKED") && !c.labels.includes("REVIEW")
        && openBlockerNumbers(config.board.repo, c.number).length === 0,
    );
  } catch (e) {
    log(`poll failed: ${e.message}`);
    return false;
  }
  if (!card) return false;
  const wt = ensureWorktree(configPath, card.number);
  if (stopping) return false;
  const { code, out } = await runPhase(card.number, card.stage, wt, configPath);
  log(`#${card.number} ${card.stage}: run-phase exit ${code}: ${out.trim().split("\n")[0] ?? ""}`);
  return code === 0 || code === 3;
}

async function main() {
  const a = parseArgs(process.argv.slice(2).filter((x) => x !== "--once"), [], ["config"]);
  const configPath = path.resolve(a.config ?? process.env.FACTORY_CONFIG ?? "factory.yml");
  const config = loadConfig(configPath);
  log(`watcher started for ${config.board.repo}`);
  for (;;) {
    let again = false;
    try {
      again = await poll(config, configPath);
    } catch (e) {
      log(`poll failed: ${e.message}`);
    }
    if (stopping || once) break;
    if (!again) await sleep(Number(config.poll_seconds || 300) * 1000);
    if (stopping) break;
  }
  log("watcher stopped");
}

main().catch((e) => {
  console.error(`factory: ${e.message}`);
  process.exit(e instanceof UsageError ? 2 : 1);
});
