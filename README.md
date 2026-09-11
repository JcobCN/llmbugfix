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

## Weekly bug-fix email

Weekly email is disabled when `WEEKLY_EMAIL_USERNAME`, `WEEKLY_EMAIL_PASSWORD`, and `WEEKLY_EMAIL_RECIPIENTS` are all absent. To enable it, configure all three; recipients are comma-separated. `WEEKLY_EMAIL_SMTP_URL` may be omitted because it defaults to `smtps://mail.onecloud.cn:465`. If supplied, that exact URL is the only accepted value: port 465 uses implicit TLS with normal certificate and hostname verification, never a plaintext or STARTTLS downgrade.

The reporting interval is calculated in `Asia/Shanghai`, independently of the host time zone. Each report covers Monday 00:00 through Saturday 09:00 as a left-closed/right-open interval (`created_at >= start AND created_at < end`). An event exactly at Saturday 09:00 is excluded. By product definition, progress from Saturday 09:00 through Sunday is not included in this or any later weekly report. Bugs are selected only by qualifying `bug_events.created_at`; changing `bug_reports.updated_at` alone does not select a bug.

The service checks the most recently due period immediately on startup and attempts it only when no delivery record exists for that period. Each period gets at most one real SMTP attempt: failures are recorded as `FAILED` with no automatic retry or backoff, and an interrupted `SENDING` record left by an abrupt process exit is never resent. Graceful shutdown cancellation is recorded as `FAILED`. A failed prior week does not block the next week's new report, which is attempted normally. Successful `SENT` periods are also never resent. The validated report snapshot and deterministic Message-ID are stored before SMTP begins. If SMTP accepts a message but the process cannot finalize its status, the record remains terminal and is not retried, favoring duplicate prevention over automatic recovery.

Delivery diagnostics stored in SQLite and emitted to logs are single-line, bounded, and redact credentials and email addresses. They intentionally omit the SMTP server's raw response and recipient list. For troubleshooting, check that all three enabling variables are present and nonblank, that the sender is a valid mailbox, that recipient entries contain no empty item, and that outbound TCP 465 and the host CA trust store are available. Never paste the password, raw SMTP transcript, Bug logs, stacks, diffs, or attachments into an issue.

Automated tests use fake mail transports and never contact `mail.onecloud.cn`. A real delivery check must be an explicit human operation in an approved environment: back up the data directory, set the four `WEEKLY_EMAIL_*` values in the process environment (using the fixed URL), start the service, confirm only the intended test recipients are configured, and verify both the plain-text and HTML alternatives in their inbox. Stop the service afterward and remove the password from shell history/environment according to local secret-handling policy. Do not add real credentials to `.env.example`, tests, artifacts, or source control.

## Local operation and dashboard

Copy `.env.example` to `.env` and keep `DRY_RUN=true` for initial validation. A static environment catalog is optional: when a report names a project that is not already configured, the real Intake asks for an HTTPS or SSH Git clone URL. After the tester explicitly confirms the report, the service clones it into `DATA_ROOT/repositories` and writes a runnable profile to `DATA_ROOT/generated-environments.yaml`; no `E2E_FRONTEND_REPOSITORY`, `FRONTEND_MAIN_REPOSITORY`, or `BACKEND_MAIN_REPOSITORY` setting is required for this flow. `LLM_ENDPOINT_URL` is the single OpenAI-compatible endpoint used by Intake, Pi Fixer, and Pi Reviewer. `LLM_ENDPOINT_URL` and `LLM_MODEL` enable real Intake; the repair worker additionally requires the externally enforced `PI_SANDBOX_PROFILE`. `VISION_HOST` remains disabled unless explicitly integrated.

Start the API with the repository/database dependencies supplied by the embedding application, then serve `renderDashboardHtml()` at `/dashboard` and `renderDetailHtml(id)` at `/bugs/:id`. The dashboard reads `GET /api/bugs` and detail reads `GET /api/bugs/:id`; both expose loading, empty and error states. Liveness is available at `/api/health/live` and readiness at `/api/health/ready` (also `/healthz` and `/readyz`).

Manual recovery is intentional: `POST /api/bugs/:id/retry` only accepts failed terminal pipeline states (including `FIX_CANDIDATE`) or a FAILED/INTERRUPTED queue job and never retries automatically. Candidate patches are checked against their recorded base/hash and resumed through validation/review; they are never pushed solely because a diff exists. `POST /api/bugs/:id/cancel` cancels queued work or requests interruption for a currently running safe stage; unsafe stages return `409` with `cancellable:false`. Stale workers are marked INTERRUPTED by the SQLite queue and require a human retry. Lock files and worktrees are cleaned only when ownership/staleness checks succeed.

Each pipeline writes its result under `DATA_ROOT/agent-results/<BUG-KEY>/` with the canonical artifacts (`bug.json`, `fix-task.json`, `environment.json`, `agent-result.json`, optional `candidate.json`, `validation.json`, `review.json`, `diff.patch`, `git-result.json`, `pipeline.json`). Artifacts are mode `0600`; missing artifacts are normal before that stage runs. Migrations are additive SQLite initialization, so a backup of the database and data root should be made before upgrading.

### Verification and boundaries

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. End-to-end tests use fake intake/agent, disabled vision, and temporary local Git remotes. They do not validate production credentials, GitLab/MR APIs, external LLMs, deployment, merge, or real network connectivity. For failures, inspect the structured redacted worker/API logs, the pipeline artifact, job heartbeat/status, and readiness response; do not paste secrets into bug conversations or logs.
