#!/usr/bin/env node
// block.mjs <issue> --need <text> --why <text> [--label BLOCKED|REVIEW] [--config <path>]
// Adds the label and writes one comment. A repeat for the same state writes no second comment.
import { checkLabel, gh, issueState, loadConfig, parseArgs, run, stamp, UsageError } from "./lib/common.mjs";

run(() => {
  const a = parseArgs(process.argv.slice(2), ["issue"], ["need", "why", "label", "config"]);
  if (!a.need || !a.why) throw new UsageError("--need and --why are required");
  const label = checkLabel(a.label);
  const { board } = loadConfig(a.config);

  const { labels, firstLines } = issueState(board.repo, a.issue);
  const mine = `factory: ${label}`;
  const last = firstLines.filter((l) => l === mine || l === `factory: cleared ${label}`).at(-1);
  if (!labels.includes(label)) gh(["issue", "edit", a.issue, "--repo", board.repo, "--add-label", label]);
  if (last === mine && labels.includes(label)) {
    console.log(`#${a.issue} is already ${label}. No new comment.`);
    return;
  }
  const body = [mine, `need: ${a.need}`, `why: ${a.why}`, `time: ${stamp()}`].join("\n");
  gh(["issue", "comment", a.issue, "--repo", board.repo, "--body", body]);
  console.log(`#${a.issue}: ${label} added`);
});
