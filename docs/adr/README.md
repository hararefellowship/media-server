# Architecture Decision Records

An ADR records one significant technical decision: the context, the decision, and its consequences.
They explain *why* the code looks the way it does, so future developers don't have to guess or re-argue it.

## Process

1. Copy [`template.md`](template.md) to `NNNN-short-title.md` (next number).
2. Open a PR with status **Proposed**.
3. The team lead reviews. On merge, set status to **Accepted** (or **Rejected**, keeping the file as a record).
4. Never rewrite an accepted ADR. If a decision changes, write a new ADR that **supersedes** the old one.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-nodejs-node-media-server-with-own-ffmpeg.md) | Node.js + node-media-server v4, with our own FFmpeg | Proposed |
| [0002](0002-hls-only.md) | Deliver HLS only (no MPEG-DASH) for now | Proposed |
| [0003](0003-single-canonical-entrypoint.md) | One canonical server entrypoint; remove experiments | Proposed |
| [0004](0004-tls-at-reverse-proxy.md) | Terminate TLS at a reverse proxy, not in Node | Proposed |
| [0005](0005-javascript-with-jsdoc-types.md) | Plain JavaScript with JSDoc type checking (no TypeScript build) | Proposed |
| [0006](0006-publish-authorization.md) | Authorize publishers against the backend | Proposed |
| [0007](0007-secrets-out-of-git.md) | Keep secrets out of git | Proposed |
