#!/usr/bin/env node
// clear.mjs <issue> --solution <text> [--label BLOCKED|REVIEW] [--config <path>]
// Removes the label and writes one comment with the solution.
import { checkLabel, gh, issueState, loadConfig, parseArgs, run, stamp, UsageError } from "./lib/common.mjs";

run(() => {
  const a = parseArgs(process.argv.slice(2), ["issue"], ["solution", "label", "config"]);
  if (!a.solution) throw new UsageError("--solution is required");
  const label = checkLabel(a.label);
  const { board } = loadConfig(a.config);

  const { labels, firstLines } = issueState(board.repo, a.issue);
  const mine = `factory: cleared ${label}`;
  const last = firstLines.filter((l) => l === mine || l === `factory: ${label}`).at(-1);
  if (labels.includes(label)) gh(["issue", "edit", a.issue, "--repo", board.repo, "--remove-label", label]);
  if (last === mine && !labels.includes(label)) {
    console.log(`#${a.issue} is already cleared of ${label}. No new comment.`);
    return;
  }
  const body = [mine, `solution: ${a.solution}`, `time: ${stamp()}`].join("\n");
  gh(["issue", "comment", a.issue, "--repo", board.repo, "--body", body]);
  console.log(`#${a.issue}: ${label} removed`);
});
