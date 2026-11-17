#!/usr/bin/env node
// stopped.mjs [--config <path>]
// Read-only. One line per card that has BLOCKED or REVIEW:
// #<n> <stage> <label> need: <text> why: <text>   (from the latest factory comment for that label)
import { gh, LABELS, loadConfig, parseArgs, run } from "./lib/common.mjs";

run(() => {
  const a = parseArgs(process.argv.slice(2), [], ["config"]);
  const { board } = loadConfig(a.config);
  const { items } = JSON.parse(
    gh(["project", "item-list", String(board.project_number), "--owner", board.owner, "--format", "json", "--limit", "500"]),
  );
  const row = (body, key) => body.split("\n").find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2) ?? "";
  for (const item of items) {
    const n = item.content?.number;
    const label = LABELS.find((l) => (item.labels ?? []).includes(l));
    if (!n || !label) continue;
    const { comments } = JSON.parse(gh(["issue", "view", String(n), "--repo", board.repo, "--json", "comments,labels"]));
    const last = comments.filter((c) => c.body.split("\n")[0] === `factory: ${label}`).at(-1)?.body ?? "";
    console.log(`#${n} ${item[board.field_name.toLowerCase()]} ${label} need: ${row(last, "need")} why: ${row(last, "why")}`);
  }
});
