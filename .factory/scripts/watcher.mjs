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
async function poll(config, configPath) {
  checkMerges(config, configPath, cards(config));
  const card = cards(config).find(
    (c) => config.commands?.[c.stage]?.command && !c.labels.includes("BLOCKED") && !c.labels.includes("REVIEW"),
  );
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
