import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseYaml } from "./yaml.mjs";

export const LABELS = ["BLOCKED", "REVIEW"];

export class UsageError extends Error {}

// "--name value" pairs after the positional arguments.
export function parseArgs(argv, positional, flags) {
  const out = {};
  const rest = [...argv];
  for (const name of positional) {
    const v = rest.shift();
    if (v === undefined || v.startsWith("--")) throw new UsageError(`missing <${name}>`);
    out[name] = v;
  }
  while (rest.length) {
    const flag = rest.shift();
    const key = flag.replace(/^--/, "");
    if (!flag.startsWith("--") || !flags.includes(key)) throw new UsageError(`unknown argument ${flag}`);
    const value = rest.shift();
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    out[key] = value;
  }
  return out;
}

export const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });

export function loadConfig(path = process.env.FACTORY_CONFIG || "factory.yml") {
  if (!fs.existsSync(path)) throw new UsageError(`no factory.yml at ${path} (set FACTORY_CONFIG or run factory:install)`);
  return parseYaml(fs.readFileSync(path, "utf8"));
}

export function checkLabel(label = "BLOCKED") {
  if (!LABELS.includes(label)) throw new UsageError(`--label must be one of ${LABELS.join(", ")}`);
  return label;
}

export const stamp = () => new Date().toISOString();

// Comments carry their kind in the first line, so a script can find its own earlier comment.
export const firstLine = (body) => body.split("\n")[0];

export function issueState(repo, issue) {
  const data = JSON.parse(gh(["issue", "view", String(issue), "--repo", repo, "--json", "comments,labels"]));
  return {
    labels: data.labels.map((l) => l.name),
    firstLines: data.comments.map((c) => firstLine(c.body)),
  };
}

export function run(main) {
  try {
    main();
  } catch (e) {
    console.error(`factory: ${e.message}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  }
}
