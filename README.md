# HCF Media Server

Live-streaming ingest and delivery service for **Harare Christian Fellowship (HCF)**.

A broadcaster (OBS or any RTMP encoder) pushes **one** stream in. The server:

1. accepts it over **RTMP** (port `1935`) using [`node-media-server`](https://www.npmjs.com/package/node-media-server) v4,
2. transcodes it with **FFmpeg** into **adaptive-bitrate HLS** (540p / 480p / 360p / 144p),
3. records an **MP4** copy of the broadcast at the same time, and
4. serves the HLS files over **HTTP** (port `8000`) to the web and mobile players.

> **Status:** active development. See [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) before deploying.

---

## Documentation

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit: stream lifecycle, output layout, dependencies, node-media-server v4 notes |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, Compose, Swarm, CI/CD, environments, TLS |
| [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) | Known bugs and gaps, with severity and proposed fixes |
| [docs/adr/](docs/adr/README.md) | Architecture Decision Records: why things are the way they are |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branching, commits, pull requests |
| [CHANGELOG.md](CHANGELOG.md) | What changed, when |

---

## Quickstart

### Prerequisites

- Node.js **20** (the Docker image uses `node:20-bookworm-slim`)
- FFmpeg at `/usr/bin/ffmpeg` (`sudo apt install ffmpeg`)
- The HCF backend API reachable at `API_BASE_URL` (default `http://host.docker.internal:7002`).
  The server still starts without it and falls back to the stream key `1970-teststream`.

### Run with Docker (dev)

```bash
docker compose -f server-docker-compose-dev.yml up --build
```

### Run directly with Node

```bash
npm install
API_BASE_URL=http://localhost:7002 node hcf-media-svr-test.js
```

> **Note:** `hcf-media-svr-test.js` currently expects Let's Encrypt certificates at
> `/etc/letsencrypt/live/test.hararechristianfellowship.org/` and will not start without them.
> See [KNOWN_ISSUES #1](docs/KNOWN_ISSUES.md#1-production-entrypoint-crashes-on-startup).

### Send a test stream

With OBS: **Settings → Stream → Custom**

| Field | Value |
|---|---|
| Server | `rtmp://<host>:1935/live` |
| Stream key | the active stream key from the backend (e.g. `2026-10-18M-sunday-school`) |

Or without OBS, a synthetic test pattern:

```bash
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -g 60 -c:a aac \
  -f flv rtmp://localhost:1935/live/<streamKey>
```

> Stream keys may only contain `A–Z a–z 0–9 _ -`. node-media-server v4 drops any other connection.

### Watch it

```
http://<host>:8000/live/<streamKey>/index.m3u8
```

Open in VLC, Safari, or any [hls.js](https://github.com/video-dev/hls.js) player.

---

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| `1935` | RTMP | Ingest from OBS/encoder |
| `8000` | HTTP | HLS playlists and segments, recordings (static files from `./media`) |
| `8443` | HTTPS | HLS over TLS, only in `hcf-media-svr-test.js` (see [ADR-0004](docs/adr/0004-tls-at-reverse-proxy.md)) |

## Configuration

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `API_BASE_URL` | `http://host.docker.internal:7002` | all servers | Base URL of the HCF backend (stream key lookup) |
| `FFMPEG_PATH` | `/usr/bin/ffmpeg` | `optimized-hcf-media-svr-test.js` only | FFmpeg binary |
| `UID` / `GID` | `1000` | Compose files | User the container runs as, so `./media` stays writable by the host user |

CI/CD variables are listed in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#cicd).

---

## Repository layout

| File | Role |
|---|---|
| **`hcf-media-svr-test.js`** | **Current entrypoint.** This is what the `Dockerfile` runs. |
| `optimized-hcf-media-svr-test.js` | Refactored candidate: FFmpeg crash recovery, per-session cleanup, graceful shutdown. Not yet wired in ([ADR-0003](docs/adr/0003-single-canonical-entrypoint.md)). |
| `test-server.js`, `server-experimenting.js`, `experimenting-media-svr-*.js` | Earlier experiments (single bitrate, with/without recording, HTTPS). Not used at runtime. |
| `Dockerfile` | Node 20 + FFmpeg image |
| `server-docker-compose-dev.yml`, `server-docker-compose-test.yml` | Single-host deployment per environment |
| `docker-compose-swarm.yml` | Experimental Swarm scaling (not production-ready) |
| `.gitlab-ci.yml`, `build.sh`, `release.sh` | CI/CD pipeline (currently disabled) |
| `media/` | Runtime output (HLS + MP4). Git-ignored. |

---

## Related documents (outside this repo)

These HCF Engineering documents give the wider product and platform context:

- *HCF Live Stream System (Web App)*: product requirements
- *HCF Software release train v1.0.0*: Feature 1, video & audio streaming
- *The Software Engineering Factory, HCF*: tech stack, microservices, DevOps standards
