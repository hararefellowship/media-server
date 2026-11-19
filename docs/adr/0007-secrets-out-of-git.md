# 0007. Keep secrets out of git

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** HCF Engineering (team lead to confirm)

## Context

`.env`, `.test.env` and `.prod.env` are committed. The CI pipeline `source`s them per branch.
Whatever they contain is visible to everyone with repo access and stays in git history even after deletion.

## Decision

1. Commit a **`.env.example`** listing every variable with a placeholder and a comment. No real values.
2. Stop tracking real env files (`git rm --cached`) and add `.env*` (except `.env.example`) to `.gitignore`.
3. Store secrets (Docker Hub credentials, SSH keys, server IPs) in the **CI secret store**
   (GitHub Actions secrets, or GitLab CI variables if mirrored) and on servers in files readable only by the deploy user.
4. If any real credential was ever committed: **rotate it**. Removing it from git does not make it secret again.

## Consequences

- ✅ Credentials are not spread with the code.
- ✅ `.env.example` documents configuration for new developers.
- ⚠️ CI needs to be updated to read variables from the secret store instead of `source .<branch>.env`.
