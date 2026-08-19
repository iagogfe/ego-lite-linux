# `ego-browser --reload` Configuration Reload Design

## Problem

The Linux host daemon keeps its initial `HostConfig` in memory. When the user changes the effective configuration, such as switching `headless` from `true` to `false`, `ego-browser --reload` currently only reconnects the CDP bridge. The existing Chromium process therefore continues with the old launch configuration, and the user receives no visible browser window until the daemon and Chromium are restarted manually.

## Goal

Make `ego-browser --reload` apply the current effective host configuration while preserving the daemon, task spaces, and existing RPC contract for reloads that do not change browser configuration.

## Non-goals

- Add a separate restart command.
- Change the default headed/headless mode.
- Modify task-space ownership or persistence behavior.
- Restart the daemon process itself.

## Design

The CLI already loads `HostConfig` before ensuring the host. For `--reload`, it will send that effective configuration as an optional RPC parameter. The daemon will keep its active configuration mutable and compare the requested configuration with the active one.

Only browser-launch fields trigger a browser restart:

- `chromePath`
- `userDataDir`
- `cdpPort`
- `headless`

When these fields are unchanged, the daemon retains the current behavior: detach and reconnect the CDP bridge, respawning Chrome only if CDP is unavailable.

When one changes, the daemon will:

1. Detach event forwarding.
2. Close the current browser through the owned `ChromeHandle`; for an attached browser without an owned PID, request browser shutdown over the current CDP bridge before closing that bridge.
3. Close the old CDP bridge.
4. Ensure Chromium with the requested configuration and connect a new CDP bridge.
5. Update the active configuration only after the new browser connection succeeds.
6. Reattach event forwarding.

If restart fails, the RPC returns `EGO_BROWSER_UNAVAILABLE`, the requested configuration is not committed, and the next browser operation can retry using the previous active configuration. Task-space state remains managed by the same daemon and is not recreated.

The daemon will accept an absent reload configuration for compatibility with existing RPC callers; in that case it performs the existing reconnect-only behavior.

## Testing

Add host-daemon tests using injected Chrome/CDP implementations that verify:

1. Reload with no browser-launch changes reconnects without invoking browser shutdown or a second ensure.
2. Reload with a changed `headless` value shuts down the old browser, ensures Chrome with the new configuration, reconnects, and updates the active configuration.
3. A failed restart returns `EGO_BROWSER_UNAVAILABLE` and leaves the active configuration unchanged.

Add CLI coverage that verifies `--reload` sends the effective configuration to the daemon RPC. Keep the existing help text and command name unchanged.

## Acceptance criteria

- Changing `headless` in the effective configuration followed by `ego-browser --reload` results in a Chromium process launched with the new mode.
- `ego-browser --reload` continues to work for unchanged configuration.
- Task spaces survive the reload.
- Restart failures are explicit and retryable.
- All existing tests pass, and new tests pass without requiring a real display or Chromium process.
