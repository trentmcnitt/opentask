# CI Pipeline Spec

## Why

OpenTask has no CI pipeline. The repo has a Docker publish workflow but nothing that verifies code quality on pushes or PRs. For a project with multiple test layers (behavioral, integration, E2E, AI quality), pre-commit hooks, and a documented PR checklist — there's no automation enforcing any of it.

The pipeline should:

1. Catch regressions before they hit main
2. Enforce the same checks the PR template already asks contributors to run manually
3. Signal engineering maturity to anyone browsing the repo

## What to Build

### Workflow: `ci.yml`

Triggers on push to `main` and pull requests targeting `main`.

All jobs run on `ubuntu-latest`. Node version is read from the `.node-version` file (currently 20.19). Dependencies are installed with `npm ci` (deterministic, clean install from lockfile).

### Jobs

**1. `quality` — Static analysis (fast, runs first)**

- Type checking (`npm run type-check`)
- Linting (`npm run lint`)
- Format checking (`npm run format:check`)

Depends on: nothing (starts immediately)

**2. `test` — Behavioral + unit tests**

- `npm test` (Vitest — behavioral tests, excludes integration and quality)

Depends on: nothing (runs in parallel with `quality`)

**3. `build` — Production build verification**

- `npm run build` (runs `prebuild.ts` then `next build`)

This catches Next.js-specific build issues (invalid page exports, config problems, build-time errors) that `tsc --noEmit` in the quality job won't find.

Depends on: `quality` passing

**4. `integration` — Integration tests**

- `npm run test:integration` (HTTP tests against a built server)

The integration test suite has its own `globalSetup.ts` that builds and starts a server — it does not consume artifacts from the `build` job. The dependency on `quality` is a gate to avoid wasting runner time on broken code.

Depends on: `quality` passing

**5. `e2e` — End-to-end tests (heaviest)**

- Install Playwright browsers (with caching — see below)
- `npm run test:e2e` (Playwright, headless Chromium)
- Upload `playwright-report/` and `test-results/` as artifacts on failure

E2E tests start their own dev server via `playwright.config.ts` (`webServer` config) with a 120-second startup timeout. First page load triggers on-demand compilation, which is slower than production but matches the existing local test workflow.

Depends on: `quality` passing

**6. `dependency-review` — PR-only security check**

- `actions/dependency-review-action@v4` — scans for vulnerable or license-violating new dependencies
- Only runs on pull requests (not pushes)
- Fails on `moderate` severity or higher

Depends on: nothing (runs independently)

### Job dependency graph

```
push/PR
  ├── quality ──┬── build
  │             ├── integration
  │             └── e2e
  ├── test
  └── dependency-review (PR only)
```

`quality` and `test` start immediately in parallel. `build`, `integration`, and `e2e` all wait for `quality`. `dependency-review` runs independently on PRs.

### Caching strategy

| What                | Path                     | Cache key                                              |
| ------------------- | ------------------------ | ------------------------------------------------------ |
| npm packages        | `~/.npm`                 | Handled by `actions/setup-node@v4` with `cache: 'npm'` |
| Next.js build cache | `.next/cache`            | `runner.os + package-lock.json hash + source hash`     |
| Playwright browsers | `~/.cache/ms-playwright` | `runner.os + package-lock.json hash`                   |

Cache `.next/cache` with restore-keys fallback so incremental builds work even when source changes. For Playwright, skip `playwright install` on cache hit but still run `playwright install-deps` for OS-level shared libraries that can't be cached.

### Action versions

- `actions/checkout@v4`
- `actions/setup-node@v4` (with `node-version-file: '.node-version'`, `cache: 'npm'`)
- `actions/cache@v4`
- `actions/upload-artifact@v4`
- `actions/dependency-review-action@v4`

### Security

- Top-level `permissions: contents: read` (least privilege)
- Grant `checks: write` to `test` and `integration` jobs (Vitest `github-actions` reporter posts annotations)
- No secrets beyond `GITHUB_TOKEN` needed (no external services)

### Vitest reporter

Add the built-in `github-actions` reporter to the reporters list in `vitest.config.ts` and `vitest.integration.config.ts` unconditionally — it no-ops outside CI and creates inline annotations on test failures in the PR files view:

```typescript
reporters: ['default', 'github-actions', 'json'],
```

### Playwright config

The existing `playwright.config.ts` already handles CI correctly:

- `forbidOnly: !!process.env.CI` — prevents `.only` from silently skipping tests
- `retries: process.env.CI ? 2 : 0` — retries flaky tests in CI

### Environment variables

Both the integration and E2E test suites set their own environment variables via their respective `globalSetup.ts` and `playwright.config.ts` files. No CI-level env var configuration is needed beyond what GitHub Actions provides by default (`CI=true`, `GITHUB_ACTIONS=true`).

### What NOT to include

- **Quality tests** (`npm run test:quality`) — these hit AI APIs and are meant for targeted local runs, not CI
- **Matrix testing** — this is a self-hosted app deployed to a known environment, not a library. Pin to the production Node version.
- **Deployment** — the existing `docker-publish.yml` handles Docker image publishing on tags. CI is about verification, not deployment.
- **Branch protection rules** — worth setting up separately in GitHub repo settings (require CI to pass before merge), but that's configuration, not a workflow file.

## Implementation notes

- The `.node-version` file is the single source of truth for Node version across local dev and CI
- The build script (`npm run build`) runs `tsx scripts/prebuild.ts` before `next build` — `tsx` is a devDependency installed by `npm ci`
- The project uses Husky + lint-staged for pre-commit hooks locally; CI runs the full checks independently
