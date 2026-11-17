// Build reports: aggregate LiteLLM spend-log rows for one factory stage run and render a
// markdown comment. The proxy's LiteLLM_SpendLogs table is the authoritative ledger —
// every omp/claude call carries spend, tokens, model and the omp session id.
import { execFileSync } from "node:child_process";

const esc = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " ");

// Aggregate rows for one session between two ISO timestamps. Returns per-model rows
// plus totals, or null when the proxy is unreachable or the session left no rows.
export function usage({ sessionId, fromIso, toIso }) {
  const table = "LiteLLM_SpendLogs";
  // toIso may be omitted: report on everything from fromIso onward (run still going).
  const window = toIso
    ? `"startTime" >= '${fromIso}' AND "startTime" < '${toIso}'`
    : `"startTime" >= '${fromIso}'`;
  const sql = [
    `SELECT model, count(*) AS calls, sum(spend) AS usd,`,
    `  sum(prompt_tokens) AS ptok, sum(completion_tokens) AS ctok`,
    `FROM "${table}"`,
    `WHERE session_id = '${sessionId}' AND ${window}`,
    `GROUP BY model ORDER BY usd DESC NULLS LAST, calls DESC;`,
  ].join("\n");
  let out;
  try {
    out = execFileSync("docker", ["exec", "litellm-db", "psql", "-U", "litellm", "-d", "litellm", "-tAc", sql], {
      encoding: "utf8", timeout: 15_000,
    });
  } catch {
    return null; // no proxy here (different host, compose down): report without numbers
  }
  const models = [];
  let calls = 0, usd = 0, ptok = 0, ctok = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [model, c, u, p, w] = line.split("|");
    const row = { model: model || "(unknown)", calls: Number(c) || 0, usd: Number(u) || 0, ptok: Number(p) || 0, ctok: Number(w) || 0 };
    models.push(row);
    calls += row.calls; usd += row.usd; ptok += row.ptok; ctok += row.ctok;
  }
  return { models, calls, usd, ptok, ctok };
}

const compact = (n) => {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
};

export function render({ stage, issue, outcome, decision, usage: u, extraLines = [] }) {
  const head = `🏭 Build report — ${stage} stage · #${issue}`;
  const lines = [head, ""];
  lines.push(`**Outcome:** ${esc(outcome)}`);
  if (decision) lines.push(`**Decision taken:** ${esc(decision)}`);
  lines.push("");
  if (!u || u.models.length === 0) {
    lines.push("_No model usage recorded for this run (no proxy rows matched)._");
  } else {
    lines.push("| Model | Calls | Tokens in | Tokens out | Cost |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const m of u.models) {
      lines.push(`| ${esc(m.model)} | ${m.calls} | ${compact(m.ptok)} | ${compact(m.ctok)} | $${m.usd.toFixed(4)} |`);
    }
    lines.push(`| **Total** | **${u.calls}** | **${compact(u.ptok)}** | **${compact(u.ctok)}** | **$${u.usd.toFixed(4)}** |`);
  }
  if (extraLines.length) {
    lines.push("", ...extraLines);
  }
  return lines.join("\n");
}
