# 0005. Plain JavaScript with JSDoc type checking (no TypeScript build)

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** HCF Engineering (team lead to confirm)

## Context

The service is small (about 400 lines once consolidated) and written in CommonJS JavaScript.
We want type safety and editor help without adding a compile step to the Docker build and CI.
`node-media-server` itself is written this way (`// @ts-check` with JSDoc types), so its types (`BaseSession` etc.) come through to our code.

## Decision

- Stay on **plain JavaScript (CommonJS)**, Node 20.
- Add `// @ts-check` and JSDoc types to source files; run `tsc --noEmit` (or the editor) for type checking only.
- Add **ESLint** (flat config) and **Prettier**, with `npm run lint` and `npm run format`.
- Use Node's built-in test runner (`node --test`) for unit tests, with no extra test framework.
- Pin the Node version (`engines` in `package.json` and `.nvmrc`).

## Consequences

- ✅ Type errors and editor autocomplete without a build step; `node src/index.js` still just runs.
- ✅ Few dependencies to maintain.
- ⚠️ JSDoc types are more verbose than TypeScript syntax.
- ⚠️ If the service grows substantially, revisit TypeScript in a new ADR.

## Alternatives considered

- **TypeScript.** Stronger tooling, but adds a build step, `dist/` output and source maps for a small service.
- **No tooling.** Status quo; style and quality depend on each developer.
