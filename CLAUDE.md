# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Claude Code Router (CCR) is a local LLM gateway and control plane. Coding agents (Claude Code, Codex, Grok CLI, Kimi CLI, OpenCode, Pi, ZCode, WorkBuddy, ...) point at one stable local endpoint; CCR resolves the provider, model, credential, and routing rules behind it, then proxies the request and records observability data.

Two ports matter:
- `3456` gateway (model traffic: `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, Gemini `generateContent` / `interactions`)
- `3458` management server (web UI + JSON-RPC API)

## Fork and upstream sync

This repository is a fork of [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router). Upstream keeps releasing and its commits are merged in regularly, so **every local change has to be written to survive the next merge**.

- Remotes: `origin` is the fork (`diogomcd/claude-code-router`), `upstream` is the original project. `main` mirrors upstream; local work lives on `custom`.
- Sync flow: `git fetch upstream`, merge `upstream/main` into `main`, then merge `main` into `custom`. Merge, never rebase, and never force-push a published branch: rewritten history turns the next sync into a conflict storm.
- Keep local changes small and localized. A new file conflicts with nothing, so prefer adding one over editing an upstream file; inside an upstream file, prefer additive, tightly scoped hunks.
- No drive-by work on upstream code: do not reformat, rename, move files, or clean up anything the task does not strictly require. Every touched line is a future conflict.
- When upstream behavior needs to change, look for an existing extension point first (config, plugins under `CCR_EXTENSIONS_DIR`, route scripts) before patching core.
- After every merge, run `npm run typecheck` and `npm test`: upstream refactors can break local changes that still look fine in isolation.

## Commands

Node 22+ is required. `npm ci` at the repo root installs all workspaces.

### Develop
```sh
npm run dev:ui        # renderer only (esbuild watch)
npm run dev:cli       # CLI runtime + renderer
npm run dev:electron  # full desktop shell (default target of build/dev.mjs)
```

### Build
```sh
npm run build:assets      # esbuild all packages into packages/*/dist (no installer)
npm run build             # build:assets + electron-builder
npm run build:app:mac     # local DMG/ZIP into release-local/
npm run build:app:win     # local NSIS installer (must run on Windows x64: native better-sqlite3)
npm run typecheck         # tsc --noEmit over every package
```

`electron-builder` runs with `npmRebuild: true`, which recompiles `better-sqlite3` in place for the Electron ABI and leaves the root `node_modules` binding unloadable by plain Node. Every packaging script therefore ends with `npm run rebuild:sqlite3:node` (`npm rebuild better-sqlite3`) to restore the Node binding. If a build is interrupted or `electron-builder` is invoked directly, run that script manually afterwards. The symptom of a stale binding is the gateway failing to start with "No available models..." / "Service failed to start": `config.sqlite` cannot be opened, so `loadAppConfig` silently falls back to the default config with zero providers. Note that `rebuild:sqlite3` is the opposite direction (rebuilds for Electron via electron-rebuild); `rebuild:sqlite3:node` restores the binding for the system Node.

### Local `ccr` is this repo

On this machine the global `ccr` is a symlink into `packages/cli` (`npm i -g` of a local path), so `ccr ui` executes this working tree and resolves `better-sqlite3` from the repo's `node_modules`. Consequences:

- Use `npm run build:assets` (or `npm run dev:cli`) to refresh what `ccr` runs. The full `npm run build` is only for producing the desktop AppImage/installer in `release/` and is not needed for daily `ccr ui` usage.
- Any checkout, merge from upstream, or native rebuild here immediately changes the `ccr` in daily use; there is no isolation between development and the installed CLI. If stability is ever preferred, replace the link with a real `npm i -g @musistudio/claude-code-router`.
- Never run `ccr stop` or `ccr ui` from an agent session. `ccr stop` kills the gateway the user relies on, and `ccr ui` starts a long-running server bound to the user's real config. If either command is needed, ask the user to run it.

### Test
```sh
npm test                  # all workspace suites + architecture tests
npm run test:core         # or test:cli / test:ui / test:electron
npm run test:architecture # cross-package boundary rules
npm run test:e2e          # Playwright (builds assets first); test:e2e:install for the browser
npm run test:system       # Docker smoke test
```

Scope filters map to subdirectories of each package's `test/` folder:
```sh
npm run test:unit -w @claude-code-router/core   # or test:integration, test:component (ui)
```

### Run a single test file

Tests are **compiled first, then executed**; there is no watch/filter runner.

1. `node build/test.mjs core --scope unit` compiles `packages/core/test/unit/**` into `.test-dist/core/test/...` as CommonJS `.js`.
2. Run one file directly:
```sh
node --test .test-dist/core/test/unit/routing/protocol-endpoints.test.js
```

`build/run-tests.mjs` normally executes the whole compiled tree with a throwaway `HOME` and `CCR_INTERNAL_*_DIR`. If a test touches config, data dirs, or SQLite, replicate those env vars instead of running against your real `~/.claude-code-router`. Electron tests must run under the `electron` binary with `ELECTRON_RUN_AS_NODE=1`; core tests fall back to it when native SQLite is unavailable under plain node.

### Other
```sh
npm run models:update     # regenerate packages/core/models.json (runs on version/prepack)
npm run docker:build && npm run docker:run
```

## Architecture

### Monorepo layout

Four npm workspaces under `packages/`, only `cli` is published (`@musistudio/claude-code-router`, binary `ccr`):

- **core** — everything real: gateway, routing, providers, profiles, storage, observability, MCP servers, management HTTP server. Never imports `electron`.
- **cli** — a single `cli.ts` that parses `ccr start|ui|serve|stop|<profile>` and boots core's management server.
- **electron** — desktop shell: windows, tray, IPC, auto-update, built-in browser, Chrome login import.
- **ui** — React renderer shared by Electron and the browser UI (`pages/home`, `pages/browser`, `pages/tray`).

Cross-package imports go through the aliases `@ccr/core/*`, `@ccr/cli/*`, `@ccr/electron/*`, `@ccr/ui/*` (and `@/*` for UI-internal paths), resolved by tsconfig `paths` and by `packageAliasPlugin` in `build/esbuild.config.mjs`. **Relative paths into another package's `src/` are a build-breaking violation** enforced by `tests/architecture/package-boundaries.test.mjs`.

### Three ways to run the same core

`packages/core/src/web/management-server.ts` is the single control plane. It is started by:
- `packages/electron/src/main/main.ts` (desktop, renderer talks over Electron IPC)
- `packages/cli/src/cli.ts` (`ccr ui` / `ccr serve`)
- `packages/core/src/entrypoints/server.ts` (`ccr-core-server`, used by Docker)

The renderer is identical in all three. In Electron it calls `window.ccr` backed by IPC channels (`packages/core/src/contracts/ipc-channels.ts`); in the browser `packages/ui/src/web-client-bridge.ts` reimplements the same surface as JSON-RPC POSTs to `/api/ccr/rpc`. **Adding a backend capability means touching all three: the core service, the IPC channel + Electron handler, and the RPC bridge.**

### Request path

The actual protocol translation and upstream calls live in the external `@the-next-ai/ai-gateway` package. CCR wraps it:

1. `gateway/core-runtime/config-compiler.ts` compiles `AppConfig` (SQLite-backed) into the gateway's own config: providers, credentials, virtual models, MCP servers, plugins. No filesystem writes here, this is asserted by an architecture test.
2. `gateway/core-runtime/supervisor.ts` spawns a child process running `gateway-bootstrap.ts`, which injects the compiled config through a virtual `GATEWAY_CONFIG_PATH` file and then `require`s the gateway entry.
3. `gateway/request/pipeline.ts` (`GatewayRequestPipeline`) is the per-request orchestrator: API-key auth and quota reservation, protocol detection (`routing/protocol-endpoints.ts`), route resolution and rewrites (`routing/config-compiler.ts`, `routing/policy-engine.ts`, user route scripts in a worker), body adaptation across protocols (`routing/protocol-adapter.ts`), upstream execution with ordered fallbacks (`gateway/upstream/executor.ts`), response stream rewriting for features, and request-log + usage capture.
4. Feature bridges under `gateway/features/` layer capabilities onto models that lack them (hosted web search, Codex patch/multi-agent bridges, context archive continuation, Cursor compat, model discovery).

`gateway/service.ts` is intentionally an 18-line compatibility facade; an architecture test fails if implementation leaks back into it or if any gateway module imports the facade. Modules extracted out of it carry the header comment "Keep this module focused on its named gateway boundary" — respect that split when adding code.

### Subprocess boundaries

Several things run outside the main process and are separate esbuild entry points (see `build/esbuild.config.mjs` and `build/test.mjs` `runtimeEntryPoints`): the gateway child, `observability/request-log-worker.ts`, `routing/route-script-worker.ts`, and the MCP servers under `mcp/`.

The lightweight MCP bundles (`fusion-vision`, `fusion-tool-fallback`, `media-tools-proxy`, `browser-web-search-proxy`) are validated at build time: max 128 KB, and they may not pull in `config/`, `storage/`, `better-sqlite3`, `electron`, or UI modules. Importing config from an MCP module fails the build, so keep them dependency-free.

### State

Config and data are SQLite, not JSON (`config/constants.ts`): `config.sqlite` in the config dir; `request-logs.sqlite`, `usage.sqlite`, `context-archive.sqlite`, certs, and log bodies in the data dir. Legacy JSON config and legacy Windows paths are migrated on load, so changes to config shape belong in `config/config.ts` plus the migration path, not only in the type.

`contracts/app.ts` (~2.5k lines) is the shared config/type surface between core, UI, and Electron. Changing it usually ripples into the config compiler, the UI forms, and the RPC bridge.

### Extensions

Runtime plugins live in a sibling repo resolved via `CCR_EXTENSIONS_DIR` (default `../ccr-extensions`). Core test compilation picks up `plugins/claude-design/test` from there when present, and `plugins/marketplace.ts` fetches the plugin index from that repo. Its absence is not an error.

## Conventions

- There is no linter or formatter; `npm run typecheck` (strict TS, `noUnusedLocals`/`noUnusedParameters`) is the only static gate and runs on `prepublishOnly`.
- Config/option object literals are written with alphabetically sorted keys (see `build/esbuild.config.mjs`, `config/constants.ts`); follow the local ordering when editing one.
- Tests are plain `node:test` + `node:assert/strict`, written as `.test.mjs` (core, cli) or `.test.ts`/`.test.tsx` (ui, electron), placed under the owning package's `test/<scope>/` mirror of the source path. Every workspace must keep a `test` script and a `test/` directory (architecture test).
- Architecture invariants are expressed as tests, not docs. Before restructuring the gateway or moving files between packages, read `tests/architecture/` and `packages/core/test/architecture/`.
- The docs site in `docs/` is a standalone Astro project with its own lockfile; it is not part of the workspaces and is deployed by `.github/workflows/docs.yml`.
