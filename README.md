# LLM Bugfix

Offline-first TypeScript monorepo foundation for the V4 bug intake and repair workflow.

```sh
pnpm install --offline
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For a safe local UI/API check (SQLite, attachments and queue only; no external service or repair worker), run `pnpm dev` and open `http://127.0.0.1:3000/`. This is an esbuild watch workflow; use `pnpm typecheck` separately for full TypeScript checking. See [USAGE.md](USAGE.md) for details.

`@llmbugfix/bug-domain` contains the V4 Zod contracts and lifecycle state machine. `@llmbugfix/bug-repository` initializes SQLite with WAL, foreign keys, and a five-second busy timeout and exports Drizzle tables and a transactional repository.

## Offline operation and dashboard

The API and worker are designed to run without network services. Copy `.env.example` to an environment file, keep `DRY_RUN=true` for local validation, and use a local Git repository when testing a gated push. `LLM_HOST` and `VISION_HOST` default to disabled adapters; no request is sent to those hosts unless an adapter is explicitly configured. `GIT_ALLOWED_HOSTS` is an allow-list and should contain only local or approved internal hosts.

Start the API with the repository/database dependencies supplied by the embedding application, then serve `renderDashboardHtml()` at `/dashboard` and `renderDetailHtml(id)` at `/bugs/:id`. The dashboard reads `GET /api/bugs` and detail reads `GET /api/bugs/:id`; both expose loading, empty and error states. Liveness is available at `/api/health/live` and readiness at `/api/health/ready` (also `/healthz` and `/readyz`).

Manual recovery is intentional: `POST /api/bugs/:id/retry` only accepts failed terminal pipeline states or a FAILED/INTERRUPTED queue job and never retries automatically. `POST /api/bugs/:id/cancel` cancels queued work or requests interruption for a currently running safe stage; unsafe stages return `409` with `cancellable:false`. Stale workers are marked INTERRUPTED by the SQLite queue and require a human retry. Lock files and worktrees are cleaned only when ownership/staleness checks succeed.

Each pipeline writes its result under `DATA_ROOT/agent-results/<BUG-KEY>/` with the nine canonical artifacts (`bug.json`, `fix-task.json`, `environment.json`, `agent-result.json`, `validation.json`, `review.json`, `diff.patch`, `git-result.json`, `pipeline.json`). Artifacts are mode `0600`; missing artifacts are normal before that stage runs. Migrations are additive SQLite initialization, so a backup of the database and data root should be made before upgrading.

### Verification and boundaries

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. End-to-end tests use fake intake/agent, disabled vision, and temporary local Git remotes. They do not validate production credentials, GitLab/MR APIs, external LLMs, deployment, merge, or real network connectivity. For failures, inspect the structured redacted worker/API logs, the pipeline artifact, job heartbeat/status, and readiness response; do not paste secrets into bug conversations or logs.
