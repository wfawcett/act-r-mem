#!/usr/bin/env node
// run-phase.mjs <issue> <stage> --cwd <worktree> [--config <path>]
// One attempt at one stage: start the worker with `omp -p`, read result.json, act on it.
// Prints one line: done, blocked or retry. Contract: phase-contract.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, parseArgs, run, UsageError } from "./lib/common.mjs";
import { render, usage } from "./lib/report.mjs";

const CAP = 2;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const oneLine = (t) => String(t).replace(/\s+/g, " ").trim();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// Subagent architecture: each stage runs as a subagent of a short-lived parent omp session.
// Maps stage -> project agent name (.factory/agents/<name>.md). Unlisted stages fall back
// to omp's general `task` agent.
const OMP_STAGE_AGENT = {
  Specify: "specify-agent",
  Ready: "ready-agent",
  "In progress": "progress-agent",
};

run(() => {
  const a = parseArgs(process.argv.slice(2), ["issue", "stage"], ["cwd", "config"]);
  if (!/^\d+$/.test(a.issue)) throw new UsageError("<issue> must be a number");
  if (!a.cwd) throw new UsageError("--cwd is required");
  if (!fs.existsSync(a.cwd) || !fs.statSync(a.cwd).isDirectory()) throw new UsageError(`--cwd ${a.cwd} is not a directory`);
  const config = loadConfig(a.config);
  const idx = config.stages?.indexOf(a.stage) ?? -1;
  if (idx < 0) throw new UsageError(`unknown stage "${a.stage}"`);
  if (idx === config.stages.length - 1) throw new UsageError(`"${a.stage}" is the last stage`);
  const cmd = config.commands?.[a.stage];
  const need = (ok, what) => { if (!ok) throw new UsageError(`stage "${a.stage}" has no ${what} in factory.yml`); };
  need(cmd && typeof cmd.command === "string" && cmd.command.trim(), "command");
  need(cmd.model || cmd.models, "model");
  need(cmd.max_turns, "max_turns");
  need(Array.isArray(cmd.allowed_tools) && cmd.allowed_tools.length, "allowed_tools");

  const dir = path.join(path.resolve(a.cwd), ".tmp", "factory", a.issue, slug(a.stage));
  const resultFile = path.join(dir, "result.json");
  const logFile = path.join(dir, "worker.log");
  const startedAt = new Date().toISOString();
  // Report cutoff: capture rows up to a moment after the worker exits, so late proxy
  // writes are not raced. Computed once here, used by postReport.
  const endedAt = () => new Date(Date.now() + 5_000).toISOString();
  const attemptsFile = path.join(dir, "attempts");
  const reasonFile = path.join(dir, "last-reason");
  fs.mkdirSync(dir, { recursive: true });

  const clearCount = () => { for (const f of [attemptsFile, reasonFile]) if (fs.existsSync(f)) fs.unlinkSync(f); };
  const readCount = () => {
    const n = fs.existsSync(attemptsFile) ? fs.readFileSync(attemptsFile, "utf8").trim() : "";
    return /^\d+$/.test(n) ? Number(n) : 0;
  };
  // Child scripts run with this node, next to this file, no shell. --config is passed through.
  const child = (script, args) => {
    const r = spawnSync(process.execPath, [path.join(HERE, script), ...args, ...(a.config ? ["--config", a.config] : [])], {
      encoding: "utf8", env: process.env,
    });
    if (r.stderr) process.stderr.write(r.stderr);
    return r.status;
  };
  const fail = () => {
    console.log(`error #${a.issue}: a board action failed in ${a.stage} (see stderr)`);
    process.exit(1);
  };
  // Post the build-report comment. Best effort: a reporting failure must never fail the stage.
  const postReport = (sessionId, outcome, extraLines) => {
    try {
      // The worker's contract writes decision-log.md beside result.json (stage defaults, choices).
      const decisionFile = path.join(dir, "decision-log.md");
      const decision = fs.existsSync(decisionFile) ? oneLine(fs.readFileSync(decisionFile, "utf8")).slice(0, 400) : undefined;
      const u = usage({ sessionId, fromIso: startedAt, toIso: endedAt() });
      const body = render({ stage: a.stage, issue: a.issue, outcome, decision, usage: u, extraLines });
      spawnSync("gh", ["issue", "comment", a.issue, "--repo", repo, "--body", body], { encoding: "utf8" });
    } catch (e) {
      console.error(`factory: report failed (stage continues): ${e.message}`);
    }
  };
  const blockAtCap = (reason) => {
    const why = `${a.stage} failed ${CAP} times. Last reason: ${oneLine(reason)}. Log: ${logFile}`;
    const status = child("block.mjs", [a.issue, "--need", `A person must find out why the ${a.stage} phase fails`, "--why", why]);
    if (status !== 0) fail();
    clearCount();
    console.log(`blocked #${a.issue}: ${a.stage} failed ${CAP} times`);
  };

  // A block that failed at the cap is retried without starting the worker.
  if (readCount() >= CAP) {
    const last = fs.existsSync(reasonFile) ? fs.readFileSync(reasonFile, "utf8") : "unknown";
    return blockAtCap(last);
  }

  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
  // Runner and models are config in factory.yml: runner: omp, models: {omp: <model|@role>}.
  // FACTORY_RUNNER overrides for a one-off test. Per-stage "models" overrides the top-level map.
  const runner = String(process.env.FACTORY_RUNNER ?? config.runner ?? "omp").toLowerCase();
  const modelOf = (c) => c?.models?.[runner];
  const model = modelOf(cmd) ?? modelOf(config) ?? (typeof cmd?.model === "string" ? cmd.model : undefined) ?? "@default";
  // run-phase fills placeholders so the worker never has to infer facts: {{issue}}, {{stage}},
  // {{repo}}, {{title}}, {{body}}. The ticket text comes from gh here, in the trusted process,
  // so a weak worker model never needs gh access just to read the card.
  const repo = config.board?.repo ?? "";
  let title = "";
  let body = "";
  if (/{{title}}|{{body}}/.test(cmd.command)) {
    const r = spawnSync("gh", ["issue", "view", a.issue, "--repo", repo, "--json", "title,body"], { encoding: "utf8" });
    if (r.status === 0) {
      const data = JSON.parse(r.stdout);
      title = data.title ?? "";
      body = data.body ?? "";
    } else {
      console.error(`factory: could not read issue ${a.issue}: ${oneLine(r.stderr)}`);
      process.exit(1);
    }
  }
  const fill = (t) => String(t).replaceAll("{{issue}}", a.issue).replaceAll("{{stage}}", a.stage).replaceAll("{{repo}}", repo)
    .replaceAll("{{title}}", title).replaceAll("{{body}}", body)
    // Code fences in injected text collide with the model's tool-call syntax (observed on
    // glm-5.3-flash: the worker stops emitting tool calls). De-fence the injected text.
    .replaceAll("```", "%%%");
  let stageText = fill(cmd.command);
  const log = fs.openSync(logFile, "w");
  let proc;
  let ompSessionId = null;
  {
    // Subagent architecture: the stage contract lives in a project agent file
    // (.factory/agents/<stage>-agent.md), and this stage runs as a HUB-VISIBLE subagent
    // of a short-lived parent omp session. The parent's only job is to spawn the agent,
    // hand it the assignment, and wait (--wait-async) for it to finish.
    const contract = fs.readFileSync(path.join(HERE, "..", "agents", "factory-worker.md"), "utf8")
      .replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    // omp has no turn cap; max_turns maps to a wall-clock ceiling (2 min per turn, minimum 10 min).
    const maxTime = Math.max(600, Number(cmd.max_turns) * 120);
    const agentName = OMP_STAGE_AGENT[a.stage] ?? "task";
    // omp discovers project agents only under <cwd>/.omp/agents. Our contracts live in
    // .factory/agents (committed), so sync the stage's agent file there before spawning.
    // Idempotent: overwrite on every run, so committed contract changes take effect.
    const agentSrc = path.join(HERE, "..", "agents", `${agentName}.md`);
    const agentDst = path.join(a.cwd, ".omp", "agents", `${agentName}.md`);
    if (agentName !== "task") {
      fs.mkdirSync(path.dirname(agentDst), { recursive: true });
      fs.copyFileSync(agentSrc, agentDst);
    }
    // The assignment IS the rendered stage command plus the facts the agent cannot infer:
    // card, stage, result file. The agent file holds the generic contract; the assignment
    // holds the card-specific instructions and artifact paths.
    const assignment = [stageText, "", `Card: #${a.issue}. Stage: ${a.stage}.`, `Result file: ${resultFile}`].join("\n");
    const prompt = `Delegate this assignment to the \`${agentName}\` agent (task tool), label it \`${a.stage}-${a.issue}\`, and wait for its result.\n\n` +
      `Assignment (pass verbatim):\n${assignment}\n\n` +
      `After the agent finishes, check every artifact path listed in the assignment exists. ` +
      `If any is missing, retry the delegation once; if it is still missing, write the result file yourself with {"status":"failed","need":"<agent> did not produce <path>"}.`;
    const ompArgs = ["-p", prompt, "--system-prompt", contract, "--model", model,
      "--max-time", String(maxTime), "--auto-approve", "--wait-async",
      // Parent does stage work ONLY through delegation: the task tool is all it needs.
      // Fewer tools = smaller system prompt = less context growth on the parent side.
      "--tools", "task",
      // Hard spend ceiling per stage invocation: a runaway delegation (e.g. the GPU
      // crawl we saw) can outlive max-time usefulness; cost is the honest bound.
      "--max-cost", String(cmd.max_cost ?? 2),
      "--no-skills", "--no-rules", "--no-context-files",
      // json mode: first event is {"type":"session","id":...} — the key that ties this
      // run to its LiteLLM spend rows. stdout is the event stream; it doubles as the log.
      "--mode", "json"];
    const jsonLog = path.join(dir, "worker.jsonl");
    const jsonFd = fs.openSync(jsonLog, "w");
    proc = spawnSync("omp", ompArgs, { cwd: a.cwd, stdio: ["ignore", jsonFd, log] });
    fs.closeSync(jsonFd);
    if (process.env.FACTORY_DEBUG) {
      fs.writeFileSync(path.join(dir, "argv.json"), JSON.stringify({ runner, model, agentName, ompArgs }, null, 2));
    }
    // Recover the session id (and keep text logs useful): first line of the event stream.
    try {
      const first = fs.readFileSync(jsonLog, "utf8").split("\n").find(Boolean);
      if (first) ompSessionId = JSON.parse(first).id;
    } catch { /* report runs without usage numbers instead */ }
  }
  fs.closeSync(log);

  // Classify the outcome: a result, or the reason it is invalid.
  let result = null;
  let reason = "";
  if (proc.error) reason = `omp could not start: ${proc.error.message}`;
  else if (proc.status !== 0) reason = `omp exited ${proc.status ?? proc.signal}`;
  else if (!fs.existsSync(resultFile)) reason = "result.json missing";
  else {
    try {
      result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    } catch {
      reason = "result.json is not valid JSON";
    }
    if (reason) result = null;
    else if (result === null || typeof result !== "object") reason = "result.json is not an object";
    else if (result && !["blocked", "failed"].includes(result?.status)) result.status = "done";
    else if (result?.status === "blocked" && !oneLine(result.need ?? "")) reason = "blocked with empty need";
    if (reason) result = null;
  }

  if (result?.status === "done") {
    // Task-per-invocation: a session that finished tasks but has a next task must not
    // advance the stage. Requeue (exit 0 => watcher re-polls immediately) without count.
    const nxt = Number(result.nextTask);
    if (a.stage === "In progress" && Number.isInteger(nxt) && nxt > 0) {
      clearCount();
      return console.log(`partial #${a.issue}: In progress done through task ${nxt - 1}; requeueing for task ${nxt}`);
    }
    // Plan-file enforcement: In progress "done" counts only when the plan's task list
    // has every numbered task marked DONE. Workers sometimes claim done early.
    if (a.stage === "In progress") {
      try {
        const specs = path.join(a.cwd, "specs");
        const planFile = fs.readdirSync(specs).find((f) => f.startsWith(`${a.issue}-plan`) && f.endsWith(".md"));
        if (planFile) {
          const planText = fs.readFileSync(path.join(specs, planFile), "utf8");
        const numbered = planText.split("\n").filter((l) => /^\d+\.\s/.test(l)).length;
        const done = planText.split("\n").filter((l) => /^DONE:/.test(l)).length;
        // Workers either append "DONE:" to the numbered line or rewrite it as a
        // "DONE: ..." line; completion = at least one DONE per numbered task.
        const remaining = Math.max(0, numbered - done);
          if (remaining > 0) {
            clearCount();
            return console.log(`partial #${a.issue}: ${remaining} plan task(s) still unmarked; requeueing`);
          }
        }
      } catch { /* plan check is advisory; fall through to normal advance */ }
    }
    const next = config.stages[idx + 1];
    postReport(ompSessionId, `done — ${a.stage} → ${next}`,
      [`Session: \`${ompSessionId ?? "n/a"}\``, `Log: \`${logFile}\``].filter(Boolean));
    const status = child("move.mjs", [a.issue, next, "--from", a.stage, "--reason", `${a.stage} phase done`]);
    if (status === 3) {
      console.log(`moved #${a.issue}: a person moved the card during ${a.stage}. Nothing changed.`);
      process.exit(3);
    }
    if (status !== 0) fail();
    clearCount();
    return console.log(`done #${a.issue}: ${a.stage} -> ${next}`);
  }
  if (result?.status === "blocked") {
    const why = `${a.stage} phase blocked. Recommended: ${oneLine(result.recommended ?? "") || "none"}`;
    postReport(ompSessionId, `blocked — need: ${oneLine(result.need)}`,
      [`Recommended: ${oneLine(result.recommended ?? "") || "none"}`, `Session: \`${ompSessionId ?? "n/a"}\``, `Log: \`${logFile}\``].filter(Boolean));
    if (child("block.mjs", [a.issue, "--need", oneLine(result.need), "--why", why]) !== 0) fail();
    clearCount();
    return console.log(`blocked #${a.issue}: ${a.stage} phase needs a person`);
  }

  // failed, or any invalid outcome
  const why = result ? oneLine(result.need ?? "") || "worker reported failed" : reason;
  postReport(ompSessionId, `failed — ${why}`,
    [`Session: \`${ompSessionId ?? "n/a"}\``, `Log: \`${logFile}\``].filter(Boolean));
  const count = readCount() + 1;
  fs.writeFileSync(attemptsFile, String(count));
  fs.writeFileSync(reasonFile, why);
  if (count < CAP) return console.log(`retry #${a.issue}: ${a.stage} attempt ${count} of ${CAP} failed (${why})`);
  blockAtCap(why);
});
