#!/usr/bin/env node
// setup.mjs <labels|ignore|config> ...  Idempotent steps used by /factory:install.
//   labels --repo OWNER/REPO               create BLOCKED and REVIEW if missing
//   ignore [--file .gitignore]             add the ".tmp/*" line if missing
//   config --repo R --owner O --number N --project-id ID --field-name NAME --field-id ID
//          --options "Stage=id,Stage=id" [--out factory.yml]   write factory.yml unless it exists
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gh, LABELS, parseArgs, run, UsageError } from "./lib/common.mjs";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "factory.yml");
const COLORS = { BLOCKED: "d73a4a", REVIEW: "fbca04" };

const labels = (a) => {
  if (!a.repo) throw new UsageError("--repo is required");
  const have = JSON.parse(gh(["label", "list", "--repo", a.repo, "--json", "name"])).map((l) => l.name);
  for (const name of LABELS) {
    if (have.includes(name)) console.log(`label ${name}: exists`);
    else {
      gh(["label", "create", name, "--repo", a.repo, "--color", COLORS[name]]);
      console.log(`label ${name}: created`);
    }
  }
};

const ignore = (a) => {
  const file = a.file || ".gitignore";
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (text.split("\n").includes(".tmp/*")) return console.log(`${file}: already ignores .tmp/*`);
  fs.writeFileSync(file, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}.tmp/*\n`);
  console.log(`${file}: added .tmp/*`);
};

const config = (a) => {
  for (const k of ["repo", "owner", "number", "project-id", "field-name", "field-id", "options"]) {
    if (!a[k]) throw new UsageError(`--${k} is required`);
  }
  const out = a.out || "factory.yml";
  if (fs.existsSync(out)) return console.log(`${out}: exists, left unchanged`);
  const options = Object.fromEntries(a.options.split(",").map((p) => p.split("=")));
  const [head, ...tail] = fs.readFileSync(TEMPLATE, "utf8").split("\nstages:");
  const set = (text, key, value) => text.replace(new RegExp(`^(\\s+${key}:).*$`, "m"), `$1 ${value}`);
  let h = head;
  for (const [key, value] of [["repo", a.repo], ["owner", a.owner], ["project_number", a.number],
    ["project_id", a["project-id"]], ["field_name", a["field-name"]], ["field_id", a["field-id"]]]) {
    h = set(h, key, value);
  }
  for (const [stage, id] of Object.entries(options)) h = set(h, stage, id);
  fs.writeFileSync(out, `${h}\nstages:${tail.join("\nstages:")}`);
  console.log(`${out}: written`);
};

run(() => {
  const [cmd, ...rest] = process.argv.slice(2);
  const steps = { labels, ignore, config };
  if (!steps[cmd]) throw new UsageError("usage: setup.mjs <labels|ignore|config> ...");
  const flags = { labels: ["repo"], ignore: ["file"],
    config: ["repo", "owner", "number", "project-id", "field-name", "field-id", "options", "out"] }[cmd];
  steps[cmd](parseArgs(rest, [], flags));
});
