# Respect profile Entry mode when syncing the Claude App config

Closes #1712

CCR rewrites the Claude desktop app config on every save, gateway start/restart, and startup, ignoring each profile's Entry mode. With a claude-code profile set to "CLI only", the app still gets pointed at the CCR gateway until the service stops.

Now `syncClaudeAppGatewayConfig` first checks whether any enabled claude-code profile can open the app (`hasClaudeAppEntryProfile`). If none can, it restores the existing backup immediately via `restoreClaudeAppGatewayConfig` and skips. Explicit "Open in App" is unaffected: that path calls `applyClaudeAppGatewayConfig` directly.

Only `claude-code` profiles count (claude-design never reads the Claude-3p config), filtered by `enabled` alone to match `findProfileForOpen`.

Side effects for CLI-only setups: `gateway.enabled` is no longer forced back to true on every save, and no "Claude App" API key is auto-minted anymore.

All changes in `packages/core/src/agents/claude-app/gateway-service.ts`; every call site inherits the behavior untouched.

## Testing

New unit tests in `packages/core/test/unit/agents/claude-app-gateway-sync.test.mjs`: skip + backup restore for `surface: "cli"`, disabled profile, claude-design-only; restore of absent files; apply for `auto`/`app`/unset surfaces and any scope.

`npm run typecheck` clean; architecture tests pass.
