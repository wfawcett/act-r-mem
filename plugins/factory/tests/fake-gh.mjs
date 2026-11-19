#!/usr/bin/env node
// Fake `gh` for tests. State lives in the JSON file named by FAKE_GH_STATE.
import fs from "node:fs";

const file = process.env.FAKE_GH_STATE;
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
s.calls.push(args);
const flag = (name) => args[args.indexOf(name) + 1];
const issue = () => s.issues[args[2]] ?? (s.issues[args[2]] = { labels: [], comments: [] });
let out = "";

const [a, b] = args;
if ((s.fail ?? []).includes(`${a} ${b}`)) {
  fs.writeFileSync(file, JSON.stringify(s));
  console.error(`fake gh: forced failure for ${a} ${b}`);
  process.exit(1);
}
if (a === "auth") {
  out = "ok";
} else if (a === "project" && b === "item-list") {
  if (flag("--limit") !== "500") {
    console.error("fake gh: item-list needs --limit 500");
    process.exit(1);
  }
  // Real shape for issue cards: top-level `labels` (names) and the stage under the lowercased field name.
  out = JSON.stringify({
    items: s.items.map((i) => ({
      id: i.id,
      content: { number: i.number },
      labels: i.labels ?? s.issues[i.number]?.labels ?? [],
      [s.fieldName.toLowerCase()]: i.stage,
    })),
  });
} else if (a === "pr" && b === "list") {
  if (!args.includes("--repo")) {
    console.error("fake gh: pr list needs --repo");
    process.exit(1);
  }
  const merged = flag("--state") === "merged";
  out = JSON.stringify((s.prs ?? []).filter((p) => !merged || p.merged).map((p) => ({ number: p.number, body: p.body })));
} else if (a === "project" && b === "item-edit") {
  const item = s.items.find((i) => i.id === flag("--id"));
  item.stage = s.options[flag("--single-select-option-id")];
} else if (a === "issue" && b === "comment") {
  issue().comments.push({ body: flag("--body") });
} else if (a === "issue" && b === "view") {
  const i = issue();
  const fields = flag("--json") ?? "";
  // Return only the requested fields, like the real gh --json does.
  const payload = {};
  if (fields.includes("labels")) payload.labels = i.labels.map((name) => ({ name }));
  if (fields.includes("comments")) payload.comments = i.comments;
  if (fields.includes("title")) payload.title = s.issues[b]?.title ?? `issue ${b}`;
  if (fields.includes("body")) payload.body = s.issues[b]?.body ?? "";
  out = JSON.stringify(payload);
} else if (a === "issue" && b === "edit") {
  const i = issue();
  if (args.includes("--add-label") && !i.labels.includes(flag("--add-label"))) i.labels.push(flag("--add-label"));
  if (args.includes("--remove-label")) i.labels = i.labels.filter((l) => l !== flag("--remove-label"));
} else if (a === "label" && b === "list") {
  out = JSON.stringify(s.repoLabels.map((name) => ({ name })));
} else if (a === "label" && b === "create") {
  s.repoLabels.push(args[2]);
} else if (a === "api" && b?.startsWith("repos/") && b.includes("/dependencies/")) {
  // Issue-dependency endpoints used by watcher.mjs: blocking (dependents) and
  // blocked_by (blockers). Both return full issue objects filtered by state.
  const [, , num] = b.split("/");
  const direction = b.endsWith("/blocking") ? "blocking" : "blocked_by";
  const deps = (s.deps ?? {})[`${direction}/${num}`] ?? [];
  out = JSON.stringify(deps.map((n) => ({ number: n, state: (s.issues[n] ?? {}).state ?? "open" })));
} else if (a === "api" && b?.startsWith("repos/") && /\/issues\/\d+$/.test(b) && args.join(" ").includes("issue_dependencies_summary")) {
  // blockerInfo call: --jq "[.state, .issue_dependencies_summary.blocked_by] | join(\" \")"
  const num = b.split("/").at(-1);
  const blockers = (s.deps ?? {})[`blocked_by/${num}`] ?? [];
  out = `${(s.issues[num] ?? {}).state ?? "open"} ${blockers.length}`;
} else {
  console.error(`fake gh: unhandled ${args.join(" ")}`);
  process.exit(9);
}
fs.writeFileSync(file, JSON.stringify(s));
process.stdout.write(out);
