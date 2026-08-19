# Configuration-Aware Browser Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ego-browser --reload` apply the current effective Chromium configuration, including switching between headed and headless mode, without recreating the daemon or task spaces.

**Architecture:** The CLI sends its already-resolved `HostConfig` in the existing `reload` RPC. The daemon compares only browser-launch fields, keeps its active configuration in the same object, and performs a transactional browser shutdown/restart only when those fields change. Unchanged reloads retain the existing CDP reconnect behavior.

**Tech Stack:** TypeScript, Node.js 22+, Node test runner, Unix-socket NDJSON RPC, Chrome DevTools Protocol.

## Global Constraints

- Preserve the existing `--reload` command and task-space state.
- Do not change the default headed/headless mode.
- Do not restart the daemon process.
- New tests must use injected Chrome/CDP implementations; no real display or Chromium is required.
- A failed configuration reload must return `EGO_BROWSER_UNAVAILABLE` and retain the previous active configuration.

---

### Task 1: Send the effective configuration with `--reload`

**Files:**
- Modify: `package/ego-linux-host/src/cli.ts:22-44, 32-48, 220-286`
- Test: `package/ego-linux-host/src/ego-client.test.ts:1-24, 211-214`

**Interfaces:**
- Consumes: `loadConfig(env): Promise<HostConfig>` and `HostConnection.request(method, params)`.
- Produces: `RunCliOptions.connectHost?: (socketPath: string) => Promise<HostConnection>` test seam and a reload RPC call shaped as `request("reload", { config })`.

- [ ] **Step 1: Write the failing CLI test**

Extend the existing `RunCliOptions` test seam with `connectHost`, import `runCli`, and add this test beside the existing CLI tests:

```ts
test("runCli sends the effective config with reload", async () => {
  const conn = mockConn();
  const configEnv = {
    EGO_HOST_SOCK: "/tmp/ego-reload.sock",
    EGO_DATA_DIR: "/tmp/ego-reload-data",
    EGO_USER_DATA_DIR: "/tmp/ego-reload-profile",
    EGO_CDP_PORT: "19321",
    EGO_HEADLESS: "0",
  };

  const code = await runCli(["--reload"], {
    env: configEnv,
    ensureHost: async () => {},
    connectHost: async () => conn,
  });

  assert.equal(code, 0);
  assert.deepEqual(conn.calls[0], [
    "reload",
    {
      config: {
        chromePath: null,
        userDataDir: "/tmp/ego-reload-profile",
        cdpPort: 19321,
        headless: false,
        hostSocket: "/tmp/ego-reload.sock",
        dataDir: "/tmp/ego-reload-data",
        seedFromChrome: false,
      },
    },
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run build && node --test dist/src/ego-client.test.js --test-name-pattern="sends the effective config"
```

Expected: FAIL because `runCli` does not accept the injected connection and currently calls `request("reload")` without parameters.

- [ ] **Step 3: Write the minimal CLI implementation**

In `RunCliOptions`, add:

```ts
/** Override host connection (tests). */
connectHost?: (socketPath: string) => Promise<HostConnection>;
```

In `runCli`, select `const connect = opts.connectHost ?? connectHost;`, use it for the doctor, reload, and harness paths, and change only the reload request to:

```ts
await conn.request("reload", { config });
```

Keep the existing output text and all non-reload behavior unchanged.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm run build && node --test dist/src/ego-client.test.js --test-name-pattern="sends the effective config"
```

Expected: PASS.

- [ ] **Step 5: Commit the CLI transport change**

```bash
git add package/ego-linux-host/src/cli.ts package/ego-linux-host/src/ego-client.test.ts
git commit -m "feat: send effective config during browser reload"
```

### Task 2: Apply changed browser configuration transactionally in the daemon

**Files:**
- Modify: `package/ego-linux-host/src/host-daemon.ts:25-45, 80-115, 195-340`
- Test: `package/ego-linux-host/src/host-daemon.test.ts:1-35, 160-330`

**Interfaces:**
- Consumes: `reload` RPC params `{ config?: HostConfig }`, `ChromeHandle.kill()`, and injected `ensureChrome`/`connectCdp` factories.
- Produces: a mutable active `HostConfig` and reload behavior that either reconnects or replaces the browser session while keeping `SpaceManager` and `EgoRuntime` alive.

- [ ] **Step 1: Write failing daemon tests for unchanged, changed, and failed reloads**

Add a `fakeCdp` helper with `send`, `sendRaw`, `onEvent`, `onMessage`, `close`, `listPageTargets`, `createTarget`, and `attach` methods matching `CdpBridge`. Add a temporary HTTP probe server that returns status 200 for `/json/version`, so the unchanged reload path sees CDP as alive without launching Chromium. Each test below runs inside `await withTempDir(async (dir) => { ... })` and closes its probe server in the same `finally` block as the daemon. Add these tests:

```ts
test("reload with unchanged browser config reconnects without restarting Chrome", async () => {
  const config = testConfig(dir);
  config.cdpPort = await startCdpProbe();
  let ensureCount = 0;
  let killCount = 0;
  const daemon = await startDaemon({
    config,
    ensureChrome: async () => {
      ensureCount++;
      return { pid: 42, cdpPort: config.cdpPort, userDataDir: config.userDataDir,
        async kill() { killCount++; } };
    },
    connectCdp: async () => fakeCdp(),
  });
  try {
    await rpcCall(daemon.socketPath, "reload", { config });
    assert.equal(ensureCount, 1);
    assert.equal(killCount, 0);
  } finally {
    await daemon.close();
  }
});

test("reload with changed browser config replaces Chrome and commits the new config", async () => {
  const config = testConfig(dir);
  config.cdpPort = await startCdpProbe();
  const requested = { ...config, headless: false };
  const ensureConfigs: HostConfig[] = [];
  let killCount = 0;
  const daemon = await startDaemon({
    config,
    ensureChrome: async (received) => {
      ensureConfigs.push({ ...received });
      return { pid: 42, cdpPort: received.cdpPort, userDataDir: received.userDataDir,
        async kill() { killCount++; } };
    },
    connectCdp: async () => fakeCdp(),
  });
  try {
    await rpcCall(daemon.socketPath, "reload", { config: requested });
    assert.equal(killCount, 1);
    assert.equal(ensureConfigs.length, 2);
    assert.equal(ensureConfigs[1].headless, false);
    assert.equal(daemon.config.headless, false);
  } finally {
    await daemon.close();
  }
});

test("reload failure keeps the previous browser config", async () => {
  const config = testConfig(dir);
  config.cdpPort = await startCdpProbe();
  const requested = { ...config, headless: false };
  let ensureCount = 0;
  const daemon = await startDaemon({
    config,
    ensureChrome: async () => {
      ensureCount++;
      if (ensureCount === 2) {
        throw Object.assign(new Error("spawn failed"), {
          error_code: "EGO_BROWSER_UNAVAILABLE",
        });
      }
      return { pid: 42, cdpPort: config.cdpPort, userDataDir: config.userDataDir,
        async kill() {} };
    },
    connectCdp: async () => fakeCdp(),
  });
  try {
    await assert.rejects(
      () => rpcCall(daemon.socketPath, "reload", { config: requested }),
      (err: any) => err.error_code === "EGO_BROWSER_UNAVAILABLE",
    );
    assert.equal(daemon.config.headless, true);
  } finally {
    await daemon.close();
  }
});
```

The tests must assert externally visible behavior and call counts, not private implementation details. The unchanged test must prove that no browser shutdown occurs; the changed test must prove the new `HostConfig` reaches `ensureChrome`; the failure test must prove rollback.

- [ ] **Step 2: Run the focused daemon tests and verify they fail**

Run:

```bash
npm run build && node --test dist/src/host-daemon.test.js --test-name-pattern="reload"
```

Expected: FAIL because the reload RPC ignores its config parameter and never performs a configuration-aware restart.

- [ ] **Step 3: Add browser-config comparison and restart helpers**

Define a browser-only projection in `host-daemon.ts`:

```ts
const BROWSER_CONFIG_KEYS = [
  "chromePath",
  "userDataDir",
  "cdpPort",
  "headless",
] as const;

type BrowserConfig = Pick<HostConfig, (typeof BROWSER_CONFIG_KEYS)[number]>;
```

Add a comparison helper that returns true when any key differs. Keep `config` as the active mutable object so the returned `HostDaemon.config` reflects successful reloads.

Add a shutdown helper that detaches forwarding, calls `chrome.kill()` when the daemon owns a positive PID, or sends `Browser.close` through the existing bridge when no owned PID exists, then closes the CDP bridge. Ignore the expected transport error caused by the browser closing itself and set `chrome` and `cdp` to null after shutdown.

- [ ] **Step 4: Make the reload RPC transactional**

Change the `reload` handler to accept an optional `params.config`.

- If no config is supplied, run the current reconnect-only path.
- If the browser-only projection is unchanged, run the current reconnect-only path.
- If it changed, copy the previous browser config, shut down the current browser, call `ensureChromeFn(requestedConfig)` unconditionally, connect CDP on `requestedConfig.cdpPort`, and attach forwarding.
- Commit the requested browser fields with `Object.assign(config, requestedConfig)` only after ensure and connect both succeed.
- If ensure or connect fails, kill any newly returned handle, restore the previous browser fields, clear the partial bridge, and rethrow as `EGO_BROWSER_UNAVAILABLE` using the existing error conversion path.
- Preserve `SpaceManager`, `runtime`, task-space ownership, and the existing reload response `{ ok: true }`.

- [ ] **Step 5: Run focused daemon tests and verify they pass**

Run:

```bash
npm run build && node --test dist/src/host-daemon.test.js --test-name-pattern="reload"
```

Expected: PASS for unchanged reload, changed reload, and failed reload.

- [ ] **Step 6: Commit the daemon change**

```bash
git add package/ego-linux-host/src/host-daemon.ts package/ego-linux-host/src/host-daemon.test.ts
git commit -m "feat: apply browser config during reload"
```

### Task 3: Document the new reload behavior

**Files:**
- Modify: `package/ego-linux-host/src/cli.ts:30-35`
- Modify: `package/ego-linux-host/README.md:89-100`
- Test: `package/ego-linux-host/src/ego-client.test.ts:211-214`

**Interfaces:**
- Consumes: the unchanged `--reload` command.
- Produces: user-facing documentation that explains when reload restarts Chromium and when it only reconnects.

- [ ] **Step 1: Write the failing documentation assertion**

Extend the existing `CLI_HELP mentions doctor and reload` test:

```ts
assert.match(CLI_HELP, /configuration/i);
```

Run `npm run build && node --test dist/src/ego-client.test.js --test-name-pattern="CLI_HELP mentions"` and confirm it fails before the help text changes.

- [ ] **Step 2: Update help and README**

Change the help description to state that `--reload` applies the current host configuration and reconnects the browser connection. Add a README subsection under diagnostics/reload explaining:

- configuration is resolved by the CLI;
- changes to `headless`, `chromePath`, `userDataDir`, or `cdpPort` restart Chromium while preserving task spaces;
- unchanged configuration only reconnects CDP;
- a failed restart returns `EGO_BROWSER_UNAVAILABLE`.

- [ ] **Step 3: Run the focused documentation tests**

Run:

```bash
npm run build && node --test dist/src/ego-client.test.js --test-name-pattern="CLI_HELP mentions|effective config"
```

Expected: PASS.

- [ ] **Step 4: Commit the documentation change**

```bash
git add package/ego-linux-host/src/cli.ts package/ego-linux-host/src/ego-client.test.ts package/ego-linux-host/README.md
git commit -m "docs: describe config-aware browser reload"
```

### Task 4: Run the complete verification suite and prepare the PR

**Files:**
- Verify: `package/ego-linux-host/src/*.ts`
- Verify: `package/ego-browser/src/*.ts`, `package/ego-browser/test/*.js`

**Interfaces:**
- Consumes: all implementation and test changes from Tasks 1–3.
- Produces: verified branch `fix/reload-applies-config` with a concise PR summary and no uncommitted generated artifacts.

- [ ] **Step 1: Run the host package test suite**

Run:

```bash
cd package/ego-linux-host && npm test
```

Expected: all host tests pass, including the new reload tests.

- [ ] **Step 2: Run the browser package test suite**

Run:

```bash
cd package/ego-browser && npm test
```

Expected: all browser tests pass; the existing circular-dependency warning remains non-fatal if it is still emitted.

- [ ] **Step 3: Inspect the final diff and repository state**

Run:

```bash
git diff main...HEAD --stat
git diff main...HEAD --check
git status --short --branch
```

Expected: only the worktree ignore commit, design/plan docs, CLI/daemon implementation, tests, and README changes are present; no generated `dist` or dependency files are tracked.

- [ ] **Step 4: Commit any final corrections and summarize the PR**

Use a focused commit for any correction found during verification. The final PR description must state:

```text
Problem: --reload did not apply changed Chromium launch configuration.
Solution: send effective HostConfig through reload RPC and transactionally restart only when browser fields change.
Verification: host npm test; browser npm test; diff --check.
```
