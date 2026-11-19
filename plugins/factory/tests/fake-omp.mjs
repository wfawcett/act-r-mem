#!/usr/bin/env node
// Fake `omp` for tests. State lives in the JSON file named by OMP_STATE:
// { calls: [{ argv, cwd }], script: [{ exit, result }] }. Call N follows script[N]:
// `exit` is the exit code (default 0); `result` is the text written to the result
// file named on the prompt's "Result file:" line (absent writes nothing).
// run-phase spawns `omp -p <prompt> ...`: the prompt embeds the assignment with the
// result path, exactly like the real headless run.
import fs from "node:fs";

const file = process.env.OMP_STATE;
if (!file) {
  console.error("fake omp: OMP_STATE is not set");
  process.exit(9);
}
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const argv = process.argv.slice(2);
const step = s.script[s.calls.length] ?? {};
s.calls.push({ argv, cwd: process.cwd() });
fs.writeFileSync(file, JSON.stringify(s));

const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const target = prompt.split("\n").find((l) => l.startsWith("Result file: "))?.slice("Result file: ".length);
if (target && typeof step.result === "string") fs.writeFileSync(target, step.result);
console.log("fake omp ran");
process.exit(step.exit ?? 0);
