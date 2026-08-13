# Init Human-readable Output Implementation Plan

> **For agentic workers:** Execute with a failing CLI test before changing the command. Do not create a Git commit unless the user explicitly requests it.

**Goal:** Make `aiw init` explain the created or preserved configuration and the next action in default output, while preserving the JSON result for scripts.

**Architecture:** Keep `LocalInitializer` and its `aiw.init/v1` result unchanged. Let `init-command.ts` select either a concise human-readable string or the existing result object based on the global `--json` option.

**Tech Stack:** TypeScript, Commander, Vitest.

## Task 1: Render the init result for people and scripts

**Files:**

- Modify: `src/cli/init-command.ts`
- Modify: `tests/cli/init-command.test.ts`

- [x] Add a CLI test that expects the created result to state the path, connector-only purpose, exclusions, and the two next commands.
- [x] Run `pnpm exec vitest run tests/cli/init-command.test.ts` and confirm it fails because the command prints JSON by default.
- [x] Render a human-readable string for `status: created` and `status: already-initialized`; keep the original result object when `--json` is set.
- [x] Run the targeted test, then `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
