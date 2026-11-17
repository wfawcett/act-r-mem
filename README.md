# Recall

Self-hosted ACT-R declarative memory service for AI agents: memories strengthen with use, fade with time, and surface when weak cues converge. Serves Claude Code, Hermes and omp from one store.

**Spec:** [`docs/recall-prd.md`](docs/recall-prd.md) — the PRD is the source of truth; FR ids in tickets and PRs cite it.

**Layout:** `packages/activation` (pure ACT-R math, PRD §10) · `apps/service` (Fastify + MCP + worker) · `apps/ui` (brain UI) · `db/migrations` · `scenarios` (replay harness) · `integrations/` (per-client glue).

**Build:** this repo is worked by a software factory — tickets on the GitHub board carry FR references; one ticket, one PR.
