# Contributing

## Branches

```mermaid
%%{init: { 'gitGraph': { 'mainBranchName': 'dev' } } }%%
gitGraph
    commit
    branch test
    checkout dev
    commit
    branch feature/my-change
    commit
    commit
    checkout dev
    merge feature/my-change
    checkout test
    merge dev
```

| Branch | Purpose | Merges from |
|---|---|---|
| `dev` | Default branch; integration of finished work | `feature/*`, `fix/*`, `docs/*` via PR |
| `test` | Deployed to the test server by CI | `dev`, when a set of changes is ready to test |
| `prod` *(planned)* | Production | `test`, after sign-off |
| `feature/<short-name>` | New functionality | branch from `dev` |
| `fix/<short-name>` | Bug fix | branch from `dev` |
| `docs/<short-name>` | Documentation only | branch from `dev` |

Rules:

- Don't commit directly to `dev`, `test` or `prod`. Open a pull request.
- Keep PRs **small and single-purpose** (one fix, one feature, one refactor). A reviewer should be able to read the whole diff.
- Separate **refactors** (no behaviour change) from **behaviour changes**, in different commits or PRs.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <what changed, imperative, ≤72 chars>

<why: the problem and the reasoning, wrapped at 72>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`.

Examples:

```
fix(rtmp): use v4 session object in postPublish handler
docs: add architecture and known issues
ci: re-enable build and deploy pipeline for test branch
```

Avoid repeating the same message (e.g. "CI/CD pipeline configs") for different changes. The log should tell the story.

## Pull requests

Every PR description should cover:

- **What:** the change, in a sentence or two.
- **Why:** link the issue, [known issue](docs/KNOWN_ISSUES.md) number or [ADR](docs/adr/README.md).
- **How it was tested:** e.g. "streamed from OBS for 10 minutes, dropped the connection, checked playback at 144p and 540p".
- **Risk / rollback:** anything the reviewer or deployer should watch for.

A PR that changes a design decision adds or updates an ADR.
A PR that changes ports, env vars, the output layout or deployment updates the docs in the same PR.
Every PR with a user-, operator- or developer-visible change adds a line under **[Unreleased]** in [CHANGELOG.md](CHANGELOG.md).

## Releases

1. Move the **[Unreleased]** entries in `CHANGELOG.md` under a new version heading with today's date.
2. Bump `version` in `package.json` to match.
3. Merge to the release branch and tag the commit: `git tag -a v1.0.0 -m "v1.0.0"`, then `git push origin v1.0.0`.

## Testing a change locally

1. Start the server (see [README → Quickstart](README.md#quickstart)).
2. Push a test stream with OBS or the `ffmpeg` test-pattern command in the README.
3. Check:
   - `media/live/<key>/index.m3u8` appears within ~5 s, with `v540p/ … v144p/` sub-folders.
   - Playback works at `http://localhost:8000/live/<key>/index.m3u8` (VLC or an hls.js page).
   - Stopping the stream stops **both** FFmpeg processes (`ps aux | grep ffmpeg`).
   - The MP4 in `media/live/<key>/` plays to the end.
