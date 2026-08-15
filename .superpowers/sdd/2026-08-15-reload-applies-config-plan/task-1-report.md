# Task 1 report: Send the effective configuration with `--reload`

## Outcome

Implemented and tested the CLI/RPC transport change. `runCli` now sends the effective `HostConfig` as `request("reload", { config })`, and `RunCliOptions` exposes the requested `connectHost` test seam.

## TDD evidence

### RED

Added the focused test in `package/ego-linux-host/src/ego-client.test.ts` before changing production code. The task brief's command was attempted after building:

```text
npm run build && node --test dist/src/ego-client.test.js --test-name-pattern="sends the effective config"
```

This checkout emits `dist/ego-client.test.js` rather than `dist/src/ego-client.test.js`, so Node reported that it could not find the requested test path. The equivalent focused command was then run:

```text
node --test --test-name-pattern="sends the effective config" dist/ego-client.test.js
```

The test failed before the assertion because `runCli` attempted the real socket connection:

```text
not ok 1 - runCli sends the effective config with reload
failureType: 'testCodeFailure'
error: 'connect ENOENT /tmp/ego-reload.sock'
```

This confirmed the missing injected connection seam.

### GREEN

After the minimal implementation, the focused command passed:

```text
npm run build && node --test --test-name-pattern="sends the effective config" dist/ego-client.test.js
```

Result:

```text
ok 1 - runCli sends the effective config with reload
1..1
# tests 1
# pass 1
# fail 0
```

The test supplies a nonexistent `EGO_CONFIG_DIR` so an ambient local config file cannot alter the expected `chromePath: null` value. This affects test determinism only.

## Implementation

- Added `connectHost?: (socketPath: string) => Promise<HostConnection>` to `RunCliOptions`.
- Selected `opts.connectHost ?? connectHost` once in `runCli`.
- Routed the doctor, reload, and harness connection paths through that selected connector.
- Changed only the reload RPC call to `await conn.request("reload", { config })`.
- Preserved existing output text and non-reload control flow.

## Final verification

Command:

```text
npm test
```

Result:

```text
tsc --noEmit                         passed
1..104
# tests 104
# pass 103
# fail 0
# skipped 1
```

Also ran `git diff --check`; it reported no errors.

## Self-review

- The reload request contains the complete effective `HostConfig` from `loadConfig(env)`.
- The socket path passed to the injected seam is `config.hostSocket`.
- The connection is still closed in the existing `finally` block.
- Doctor and normal harness behavior retain their existing request/output behavior; only connection construction is injectable.
- No daemon-side consumer or reload semantics were changed.
- Changes are limited to the requested CLI and test files.
