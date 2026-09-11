# LLM Bugfix

Offline-first TypeScript monorepo application for the V4 bug intake and repair workflow.

```sh
pnpm install --offline --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All projects under `apps/*` and `packages/*` are private internal workspaces. They define code and dependency boundaries, but are not independently published, built, or imported by Node at runtime. `pnpm typecheck` uses `tsc --noEmit`; `pnpm build` then uses esbuild to produce the runnable service, source map, and Web assets under the single root `dist/` directory without writing generated files into `src/`.

Use `pnpm start` for a production-style local run. It rebuilds and starts `dist/local-server.mjs` from the repository root. The `dist/` directory contains compiled application assets, not a standalone deployment: runtime `node_modules`, configuration, environment variables, and a writable `DATA_ROOT` must also be supplied.

Run `pnpm dev` and open `http://127.0.0.1:8033/`. Without LLM settings this is a safe UI/API-only mode. `LLM_ENDPOINT_URL` and `LLM_MODEL` enable the real Intake conversation; the Pi repair worker additionally requires `PI_SANDBOX_PROFILE`, a name for an externally enforced host/container sandbox, and stays disabled when it is absent. Prompt text and `DRY_RUN` are not security boundaries. To listen on all interfaces, use `pnpm dev -- --host`. See [USAGE.md](USAGE.md) for the minimal configuration and safety boundary.

`@llmbugfix/bug-domain` contains the V4 Zod contracts and lifecycle state machine. `@llmbugfix/bug-repository` initializes SQLite with WAL, foreign keys, and a five-second busy timeout and exports Drizzle tables and a transactional repository.

## Local operation and dashboard

Copy `.env.example` to `.env` and keep `DRY_RUN=true` for initial validation. A static environment catalog is optional: when a report names a project that is not already configured, the real Intake asks for an HTTPS or SSH Git clone URL. After the tester explicitly confirms the report, the service clones it into `DATA_ROOT/repositories` and writes a runnable profile to `DATA_ROOT/generated-environments.yaml`; no `E2E_FRONTEND_REPOSITORY`, `FRONTEND_MAIN_REPOSITORY`, or `BACKEND_MAIN_REPOSITORY` setting is required for this flow. `LLM_ENDPOINT_URL` is the single OpenAI-compatible endpoint used by Intake, Pi Fixer, and Pi Reviewer. `LLM_ENDPOINT_URL` and `LLM_MODEL` enable real Intake; the repair worker additionally requires the externally enforced `PI_SANDBOX_PROFILE`. `VISION_HOST` remains disabled unless explicitly integrated.

Start the API with the repository/database dependencies supplied by the embedding application, then serve `renderDashboardHtml()` at `/dashboard` and `renderDetailHtml(id)` at `/bugs/:id`. The dashboard reads `GET /api/bugs` and detail reads `GET /api/bugs/:id`; both expose loading, empty and error states. Liveness is available at `/api/health/live` and readiness at `/api/health/ready` (also `/healthz` and `/readyz`).

Manual recovery is intentional: `POST /api/bugs/:id/retry` only accepts failed terminal pipeline states (including `FIX_CANDIDATE`) or a FAILED/INTERRUPTED queue job and never retries automatically. Candidate patches are checked against their recorded base/hash and resumed through validation/review; they are never pushed solely because a diff exists. `POST /api/bugs/:id/cancel` cancels queued work or requests interruption for a currently running safe stage; unsafe stages return `409` with `cancellable:false`. Stale workers are marked INTERRUPTED by the SQLite queue and require a human retry. Lock files and worktrees are cleaned only when ownership/staleness checks succeed.

Each pipeline writes its result under `DATA_ROOT/agent-results/<BUG-KEY>/` with the canonical artifacts (`bug.json`, `fix-task.json`, `environment.json`, `agent-result.json`, optional `candidate.json`, `validation.json`, `review.json`, `diff.patch`, `git-result.json`, `pipeline.json`). Artifacts are mode `0600`; missing artifacts are normal before that stage runs. Migrations are additive SQLite initialization, so a backup of the database and data root should be made before upgrading.

### Verification and boundaries

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. End-to-end tests use fake intake/agent, disabled vision, and temporary local Git remotes. They do not validate production credentials, GitLab/MR APIs, external LLMs, deployment, merge, or real network connectivity. For failures, inspect the structured redacted worker/API logs, the pipeline artifact, job heartbeat/status, and readiness response; do not paste secrets into bug conversations or logs.
