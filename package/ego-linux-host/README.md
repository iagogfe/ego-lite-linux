# ego-linux-host

ego-shaped Linux host for ego lite: a long-lived Chromium supervisor plus CLI shim so agents can run `ego-browser` heredocs against a shared browser on Linux/WSL.

This is **not** the Citro/macOS ego app. It is an OSS-friendly host that approximates the ego product model (shared profile/logins, Task Spaces as tab sets + ownership, CDP-only) on stock Chromium.

**Design spec:** [`docs/superpowers/specs/2026-07-23-ego-linux-host-design.md`](../../docs/superpowers/specs/2026-07-23-ego-linux-host-design.md)

## Status

Scaffold only (Task 0): package layout, TypeScript build, and path defaults. Daemon, CDP bridge, spaces, and CLI land in later tasks.

## Requirements

- Node.js ≥ 22
- ESM only

## Build and test

```bash
npm install
npm run build     # esbuild: src/**/*.ts → dist/
npm run typecheck
npm test          # build + typecheck + node --test dist/**/*.test.js
```

## Path defaults

| Helper | Env override | Default |
|--------|--------------|---------|
| `defaultDataDir()` | `EGO_DATA_DIR` | `$XDG_DATA_HOME/ego-lite` or `~/.local/share/ego-lite` |
| `defaultConfigDir()` | `EGO_CONFIG_DIR` | `$XDG_CONFIG_HOME/ego-lite` or `~/.config/ego-lite` |
| `defaultProfileDir()` | `EGO_USER_DATA_DIR` | `<dataDir>/profile` |
| `defaultSocketPath()` | `EGO_HOST_SOCK` | `<dataDir>/host.sock` |
| `defaultCdpPort()` | `EGO_CDP_PORT` | `9222` |

## Source layout

```text
package/ego-linux-host/
  package.json
  tsconfig.json
  scripts/build.mjs
  src/
    paths.ts
    paths.test.ts
  dist/                 # build output (gitignored)
```

## Related

- Helper harness: [`package/ego-browser`](../ego-browser)
- Agent skill: [`skills/ego-browser`](../../skills/ego-browser)
