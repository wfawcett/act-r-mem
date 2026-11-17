#!/usr/bin/env node
// move.mjs <issue> <stage> --from <stage> --reason <text> [--config <path>]
// Reads the card's column again. Moves it only if it is still in --from.
import { gh, loadConfig, parseArgs, run, stamp, UsageError } from "./lib/common.mjs";

run(() => {
  const a = parseArgs(process.argv.slice(2), ["issue", "stage"], ["from", "reason", "config"]);
  if (!a.from || !a.reason) throw new UsageError("--from and --reason are required");
  const { board } = loadConfig(a.config);
  for (const s of [a.stage, a.from]) if (!(s in board.options)) throw new UsageError(`unknown stage "${s}"`);

  const { items } = JSON.parse(
    gh(["project", "item-list", String(board.project_number), "--owner", board.owner, "--format", "json", "--limit", "500"]),
  );
  const item = items.find((i) => String(i.content?.number) === a.issue);
  if (!item) throw new UsageError(`issue #${a.issue} is not on the board`);
  const current = item[board.field_name.toLowerCase()];
  if (current !== a.from) {
    console.error(`factory: #${a.issue} is in "${current}", not "${a.from}". Nothing changed.`);
    process.exit(3);
  }

  gh([
    "project", "item-edit", "--id", item.id, "--project-id", board.project_id,
    "--field-id", board.field_id, "--single-select-option-id", board.options[a.stage],
  ]);
  const body = [`factory: moved ${a.from} -> ${a.stage}`, `reason: ${a.reason}`, `time: ${stamp()}`].join("\n");
  gh(["issue", "comment", a.issue, "--repo", board.repo, "--body", body]);
  console.log(`#${a.issue}: ${a.from} -> ${a.stage}`);
});
