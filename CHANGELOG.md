# Changelog

All notable changes to the HCF Media Server are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once the first version is tagged.

## How to update this file

- Every PR that changes behaviour, configuration, deployment or docs adds a line under **[Unreleased]**.
- Use the headings `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- Write for the people running and using the server: what changed and what they need to do, not how the code works.
- Link the [known issue](docs/KNOWN_ISSUES.md) or [ADR](docs/adr/README.md) where one exists.
- On release, rename **[Unreleased]** to the version and date (e.g. `## [1.0.0] - 2026-12-01`),
  tag the commit `v1.0.0`, and start a new empty **[Unreleased]** section.

---

## [Unreleased]

### Added

- Project documentation for development and handover:
  - `README.md` rewritten: overview, quickstart, test-stream instructions, ports, configuration, repository layout.
  - `docs/ARCHITECTURE.md`: system context, stream lifecycle, HLS output layout (verified against FFmpeg 8.0),
    encoding ladder, node-media-server v4 behaviour notes.
  - `docs/DEPLOYMENT.md`: environments, Docker/Compose/Swarm, TLS, CI/CD state and required variables, operations.
  - `docs/KNOWN_ISSUES.md`: 14 reviewed issues with severity and proposed fixes.
  - `docs/adr/`: Architecture Decision Records 0001–0007 (all **Proposed**) with index and template.
  - `CONTRIBUTING.md`: branching model, commit convention, PR checklist, manual test steps.
  - `CHANGELOG.md` (this file).

---

## Pre-release history (untagged)

No version has been tagged yet. The entries below are reconstructed from the git history so the project's
evolution is documented. Commit hashes are given for reference.

### 2026-11-19: CI/CD and deployment configuration

#### Added

- GitLab CI pipeline (`.gitlab-ci.yml`): build and push the Docker image, then deploy over SSH to the `test`
  server using `server-docker-compose-<branch>.yml`. (`04960f2`)
- Per-environment Compose files `server-docker-compose-dev.yml` and `server-docker-compose-test.yml`. (`f581874`)
- `build.sh`, `release.sh`, and per-branch env files `.env`, `.test.env`, `.prod.env`. (`5fe469c`)
- Initial `README.md`. (`3af0326`)

#### Changed

- Server files renamed from `*-streaming-*` to `*-media-svr-*`; `docker-compose.yml` renamed to
  `server-docker-compose-dev.yml`. The `Dockerfile` now runs `hcf-media-svr-test.js`. (`f581874`)
- The CI pipeline was commented out in full; it currently does not run. (`5fe469c`)

### 2026-11-19: Resilience: API retry, fallback and FFmpeg supervision

#### Added

- Stream-key lookup from the backend (`GET /api/v1/streams/getActiveLiveStream`) retries up to 3 times with
  exponential backoff and jitter, and falls back to the key `1970-teststream`. (`8178dab`)
- `optimized-hcf-streaming-svr-test.js` (now `optimized-hcf-media-svr-test.js`): FFmpeg crash recovery with backoff
  (up to 5 restarts), module-level process registries, per-session cleanup, graceful shutdown on SIGTERM/SIGINT,
  and `POST /api/streams/create`. Not yet used by the Docker image. (`8178dab`)
- HTTPS on port 8443 using Let's Encrypt certificates for `test.hararechristianfellowship.org`. (`9b206e6`)

#### Changed

- `experimenting-streaming-server.js` renamed to `hcf-streaming-svr-test.js` and made the Docker entrypoint. (`8178dab`)

#### Removed

- Early prototypes: `app.js`, `app-working.js`, `live-server.js`, `server.js`, `server-http.js`, `sunday-schoo.js`. (`8178dab`)

#### Known problems introduced

- The HTTPS change makes the entrypoint fail at startup inside Docker
  ([KNOWN_ISSUES #1](docs/KNOWN_ISSUES.md#1-production-entrypoint-crashes-on-startup)). (`9b206e6`)

### 2026-11-18: Docker and Swarm

#### Added

- `Dockerfile` (Node 20 + FFmpeg) and `docker-compose.yml` with host networking and a `./media` volume. (`ca9acf2`)
- Experimental `docker-compose-swarm.yml` (2 replicas, CPU/memory limits). (`ca9acf2`)
- Server variants with and without MP4 recording, and `test-server.js`. (`ca9acf2`)

### 2026-10-22: Initial commit

#### Added

- First prototypes of the RTMP → FFmpeg → HLS pipeline on `node-media-server` v4 and Express,
  including `server-experimenting.js` (multi-bitrate HLS). (`047a180`)
