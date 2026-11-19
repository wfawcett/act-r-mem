#!/usr/bin/env node
// Fake `claude` for tests. State lives in the JSON file named by FAKE_CLAUDE_STATE:
// { calls: [{ argv, cwd }], script: [{ exit, result }] }. Call N follows script[N]:
// `exit` is the exit code (default 0) and `result` is the text written to the
// result file named on the prompt's "Result file:" line (null or absent writes nothing).
import fs from "node:fs";

const file = process.env.FAKE_CLAUDE_STATE;
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const argv = process.argv.slice(2);
const step = s.script[s.calls.length] ?? {};
s.calls.push({ argv, cwd: process.cwd() });
fs.writeFileSync(file, JSON.stringify(s));

const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const target = prompt.split("\n").find((l) => l.startsWith("Result file: "))?.slice("Result file: ".length);
if (target && typeof step.result === "string") fs.writeFileSync(target, step.result);
console.log("fake claude ran");
process.exit(step.exit ?? 0);
