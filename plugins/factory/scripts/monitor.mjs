#!/usr/bin/env node
// monitor.mjs [--config <path>] [--interval <sec>] [--timeout <min>]
// One event, then exit 0: prints and stops the moment the board needs a person or
// the main thread. Designed to run as a background job — the parent `wait`s on it
// instead of sleep-polling. Wakes on, in priority order:
//   GATE EVENT   a live card reached a human-gate stage (a stage with no command)
//   BLOCK EVENT  a live card got BLOCKED
//   PR EVENT     an open PR appeared (auto-merge may have missed it)
// Prints nothing while polling. Exits 1 on failure, 0 on event or timeout.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./lib/yaml.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const flagValue = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback;
};
const cfgIdx = process.argv.indexOf("--config");
const configPath = path.resolve(cfgIdx > -1 ? process.argv[cfgIdx + 1] : process.env.FACTORY_CONFIG ?? "factory.yml");
const config = parseYaml(fs.readFileSync(configPath, "utf8"));
const board = config.board;

const interval = flagValue("--interval", 120);
const timeoutMin = flagValue("--timeout", 340);

// Human gates: stages with no command in factory.yml (workers are config-driven).
const gates = config.stages.filter(
  (s) => s !== "Backlog" && s !== "Done" && !config.commands?.[s]?.command,
);
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });

function boardState() {
  const { items } = JSON.parse(
    gh(["project", "item-list", String(board.project_number), "--owner", board.owner, "--format", "json", "--limit", "500"]),
  );
  return items
    .filter((i) => i.content?.number)
    .map((i) => ({ number: i.content.number, stage: i[board.field_name.toLowerCase()], labels: (i.labels ?? []).map((l) => l.name) }));
}

function openPr() {
  const prs = JSON.parse(gh(["pr", "list", "--repo", board.repo, "--state", "open", "--json", "number"]));
  return prs.map((p) => p.number);
}

const deadline = Date.now() + timeoutMin * 60_000;
for (let i = 0; Date.now() < deadline; i++) {
  try {
    const list = boardState();
    // Highest-priority: a card waiting on a human gate.
    const gate = list.filter((c) => gates.includes(c.stage) && !c.labels.includes("BLOCKED"));
    if (gate.length) {
      console.log(`GATE EVENT: ${gate.map((c) => `#${c.number} ${c.stage}`).join(", ")}`);
      process.exit(0);
    }
    // A live card blocked (cascade labels are on dependents too, so any BLOCKED counts).
    const blocked = list.filter((c) => c.stage !== "Backlog" && c.stage !== "Done" && c.labels.includes("BLOCKED"));
    if (blocked.length) {
      console.log(`BLOCK EVENT: ${blocked.map((c) => `#${c.number}`).join(", ")}`);
      process.exit(0);
    }
    // An open PR: either auto-merge failed or a card reached In review.
    const prs = openPr();
    if (prs.length) {
      console.log(`PR EVENT: open PR(s) ${prs.map((n) => `#${n}`).join(", ")}`);
      process.exit(0);
    }
  } catch (e) {
    console.error(`monitor: poll failed: ${e.message}`);
    process.exit(1);
  }
  const left = Math.min(interval, Math.ceil((deadline - Date.now()) / 1000));
  if (left <= 0) break;
  execFileSync("sleep", [String(left)]);
}
console.log(`MONITOR TIMEOUT ${timeoutMin}min — no events`);
process.exit(0);
