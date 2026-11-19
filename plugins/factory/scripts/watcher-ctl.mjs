#!/usr/bin/env node
// watcher-ctl.mjs start|stop|status [--config <path>]
// State lives in ~/.factory/<repo>/watcher.pid and watcher.log.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, parseArgs, run, UsageError } from "./lib/common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const a = parseArgs(process.argv.slice(2), ["action"], ["config"]);
  if (!["start", "stop", "status"].includes(a.action)) throw new UsageError("action must be start, stop or status");
  const configPath = path.resolve(a.config ?? process.env.FACTORY_CONFIG ?? "factory.yml");
  let board;
  try {
    ({ board } = loadConfig(configPath));
  } catch (e) {
    throw e instanceof UsageError ? e : new UsageError(`bad factory.yml at ${configPath}: ${e.message}`);
  }
  if (!/^[^/]+\/[^/]+$/.test(String(board?.repo ?? ""))) throw new UsageError(`board.repo in ${configPath} must be OWNER/REPO`);
  const dir = path.join(os.homedir(), ".factory", String(board.repo).split("/")[1]);
  const pidFile = path.join(dir, "watcher.pid");
  const logFile = path.join(dir, "watcher.log");
  const livePid = () => {
    if (!fs.existsSync(pidFile)) return null;
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
  };

  const pid = livePid();
  if (a.action === "status") {
    console.log(pid ? `running, pid ${pid}` : "not running");
    return console.log(`log: ${logFile}`);
  }
  if (a.action === "start") {
    if (pid) return console.log(`already running, pid ${pid}`);
    fs.mkdirSync(dir, { recursive: true });
    const out = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, [path.join(HERE, "watcher.mjs"), "--config", configPath], {
      detached: true, stdio: ["ignore", out, out], env: process.env,
    });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid));
    return console.log(`started, pid ${child.pid}`);
  }
  if (!pid) {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    return console.log("not running");
  }
  process.kill(pid, "SIGTERM");
  fs.unlinkSync(pidFile);
  for (let i = 0; i < 100 && alive(pid); i++) await pause(100);
  console.log(alive(pid) ? `sent SIGTERM to pid ${pid}, still shutting down` : `stopped, pid ${pid}`);
}

run(() => {
  main().catch((e) => {
    console.error(`factory: ${e.message}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  });
});
