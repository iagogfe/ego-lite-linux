import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon, HOST_VERSION } from "./host-daemon.js";
import {
  decodeLine,
  encodeRequest,
  isRpcResponse,
  LineBuffer,
} from "./rpc.js";
import type { HostConfig } from "./config.js";
import type { CdpBridge } from "./cdp-bridge.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(
    tmpdir(),
    `ego-host-daemon-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpcCall(
  socketPath: string,
  method: string,
  params?: object,
  id = 1,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    const buf = new LineBuffer();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`RPC timeout: ${method}`));
    }, 5000);

    sock.on("connect", () => {
      sock.write(encodeRequest({ id, method, params }));
    });
    sock.on("data", (chunk) => {
      for (const line of buf.push(chunk)) {
        try {
          const msg = decodeLine(line);
          if (isRpcResponse(msg) && msg.id === id) {
            clearTimeout(timer);
            sock.end();
            if (msg.error) {
              reject(
                Object.assign(new Error(msg.error.message), {
                  error_code: msg.error.code,
                }),
              );
            } else {
              resolve(msg.result);
            }
          }
        } catch (err) {
          clearTimeout(timer);
          sock.destroy();
          reject(err);
        }
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function testConfig(dir: string): HostConfig {
  return {
    chromePath: null,
    userDataDir: join(dir, "profile"),
    cdpPort: 19222,
    headless: true,
    hostSocket: join(dir, "host.sock"),
    dataDir: dir,
    seedFromChrome: false,
  };
}

function fakeCdp(): CdpBridge {
  return {
    async send() {
      return {};
    },
    sendRaw() {},
    onEvent() {
      return () => {};
    },
    onMessage() {
      return () => {};
    },
    async close() {},
    async listPageTargets() {
      return [];
    },
    async createTarget() {
      return "target";
    },
    async attach() {
      return "session";
    },
  };
}

async function startCdpProbe(): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const server = createHttpServer((req, res) => {
    res.writeHead(req.url === "/json/version" ? 200 : 404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("CDP probe did not expose a TCP port");
  }
  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    async close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await closePromise;
    },
  };
}

test("daemon listens and answers ping without Chrome", async () => {
  await withTempDir(async (dir) => {
    const daemon = await startDaemon({
      config: testConfig(dir),
      skipChrome: true,
      writePid: true,
    });
    try {
      const result = await rpcCall(daemon.socketPath, "ping");
      assert.deepEqual(result, { ok: true, version: HOST_VERSION });
    } finally {
      await daemon.close();
    }
  });
});

test("daemon doctor and ego.listTaskSpaces without Chrome", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const daemon = await startDaemon({
      config,
      skipChrome: true,
    });
    try {
      const doctor = await rpcCall(daemon.socketPath, "doctor");
      assert.equal(doctor.ok, true);
      assert.equal(doctor.version, HOST_VERSION);
      assert.equal(doctor.chromePath, config.chromePath);
      assert.equal(typeof doctor.chromeRunning, "boolean");
      assert.equal(doctor.cdpPort, config.cdpPort);
      assert.equal(doctor.cdpUp, false);
      assert.equal(doctor.profileDir, config.userDataDir);
      assert.equal(doctor.socketPath, daemon.socketPath);
      assert.equal(typeof doctor.daemonPid, "number");
      assert.ok(doctor.daemonPid > 0);
      assert.ok(doctor.spaceCount >= 1);
      assert.ok(
        doctor.selectedSpace === null ||
          (typeof doctor.selectedSpace === "object" &&
            doctor.selectedSpace !== null),
      );
      assert.equal(doctor.headless, config.headless);
      assert.equal(typeof doctor.displayEnv, "boolean");
      // Daemon leaves harnessPath null; CLI merges the resolved path.
      assert.equal(doctor.harnessPath, null);

      const spaces = await rpcCall(daemon.socketPath, "ego.listTaskSpaces");
      assert.ok(Array.isArray(spaces.taskSpaces));
      assert.ok(spaces.taskSpaces.some((s: any) => s.id === 1));

      const created = await rpcCall(daemon.socketPath, "ego.createTaskSpace", {
        name: "from-rpc",
      });
      assert.equal(created.name, "from-rpc");
      assert.equal(created.ownership, "agent");
    } finally {
      await daemon.close();
    }
  });
});

test("daemon rejects unknown methods", async () => {
  await withTempDir(async (dir) => {
    const daemon = await startDaemon({
      config: testConfig(dir),
      skipChrome: true,
    });
    try {
      await assert.rejects(
        () => rpcCall(daemon.socketPath, "nope.method"),
        (err: any) => err.error_code === "EGO_INVALID_ARGUMENT",
      );
    } finally {
      await daemon.close();
    }
  });
});

test("daemon respawns Chrome via ensureChrome when CDP is down on ego method", async () => {
  await withTempDir(async (dir) => {
    let ensureCount = 0;
    const pages = [
      {
        targetId: "t1",
        title: "blank",
        url: "about:blank",
        type: "page",
      },
    ];
    const config = testConfig(dir);
    // Port with nothing listening → isCdpUp false → ensureBrowserReady re-calls ensureChrome.
    config.cdpPort = 1;

    const daemon = await startDaemon({
      config,
      ensureChrome: async () => {
        ensureCount++;
        return {
          pid: 42,
          cdpPort: config.cdpPort,
          userDataDir: config.userDataDir,
          async kill() {},
        };
      },
      connectCdp: async () => ({
        async send() {
          return {};
        },
        sendRaw() {},
        onEvent() {
          return () => {};
        },
        onMessage() {
          return () => {};
        },
        async close() {},
        async listPageTargets() {
          return pages;
        },
        async createTarget(url: string) {
          return `new-${url}`;
        },
        async attach() {
          return "session-1";
        },
      }),
    });
    try {
      assert.equal(ensureCount, 1, "start ensures Chrome once");
      const tabs = await rpcCall(daemon.socketPath, "ego.listTabs");
      assert.ok(Array.isArray(tabs.tabs));
      assert.ok(
        ensureCount >= 2,
        `expected respawn ensureChrome after CDP down, got ${ensureCount}`,
      );
    } finally {
      await daemon.close();
    }
  });
});

test("daemon throws EGO_BROWSER_UNAVAILABLE when ensureChrome fails on ego method", async () => {
  await withTempDir(async (dir) => {
    let ensureCount = 0;
    const config = testConfig(dir);
    config.cdpPort = 1;

    const daemon = await startDaemon({
      config,
      ensureChrome: async () => {
        ensureCount++;
        if (ensureCount === 1) {
          return {
            pid: 0,
            cdpPort: config.cdpPort,
            userDataDir: config.userDataDir,
            async kill() {},
          };
        }
        const err = Object.assign(new Error("Chrome binary not found"), {
          error_code: "EGO_BROWSER_UNAVAILABLE",
        });
        throw err;
      },
      connectCdp: async () => ({
        async send() {
          return {};
        },
        sendRaw() {},
        onEvent() {
          return () => {};
        },
        onMessage() {
          return () => {};
        },
        async close() {},
        async listPageTargets() {
          return [];
        },
        async createTarget() {
          return "t";
        },
        async attach() {
          return "s";
        },
      }),
    });
    try {
      await assert.rejects(
        () => rpcCall(daemon.socketPath, "ego.listTabs"),
        (err: any) => {
          assert.equal(err.error_code, "EGO_BROWSER_UNAVAILABLE");
          assert.match(String(err.message), /Chrome|unavailable|binary/i);
          return true;
        },
      );
    } finally {
      await daemon.close();
    }
  });
});

test("daemon starts and doctor answers when Chrome is missing at startup", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    config.cdpPort = 1;

    // No Chrome on the machine at all: the daemon used to die here, which took
    // --doctor down with it and left the CLI printing a socket timeout.
    const daemon = await startDaemon({
      config,
      ensureChrome: async () => {
        throw Object.assign(
          new Error("Chrome/Chromium binary not found. Set EGO_CHROME_PATH"),
          { error_code: "EGO_BROWSER_UNAVAILABLE" },
        );
      },
    });
    try {
      assert.deepEqual(await rpcCall(daemon.socketPath, "ping"), {
        ok: true,
        version: HOST_VERSION,
      });

      const doctor = await rpcCall(daemon.socketPath, "doctor", undefined, 2);
      assert.equal(doctor.ok, true);
      assert.equal(doctor.cdpUp, false);
      assert.equal(doctor.chromeRunning, false);
      assert.match(String(doctor.chromeError), /binary not found/);

      // ego methods still gate on the browser, but now say why.
      await assert.rejects(
        () => rpcCall(daemon.socketPath, "ego.listTaskSpaces", undefined, 3),
        (err: any) => {
          assert.equal(err.error_code, "EGO_BROWSER_UNAVAILABLE");
          assert.match(String(err.message), /binary not found/);
          return true;
        },
      );
    } finally {
      await daemon.close();
    }
  });
});

test("reload with unchanged browser config reconnects without restarting Chrome", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const probe = await startCdpProbe();
    config.cdpPort = probe.port;
    let ensureCount = 0;
    let killCount = 0;
    const daemon = await startDaemon({
      config,
      ensureChrome: async () => {
        ensureCount++;
        return {
          pid: 42,
          cdpPort: config.cdpPort,
          userDataDir: config.userDataDir,
          async kill() {
            killCount++;
          },
        };
      },
      connectCdp: async () => fakeCdp(),
    });
    try {
      await rpcCall(daemon.socketPath, "reload", { config });
      assert.equal(ensureCount, 1);
      assert.equal(killCount, 0);
    } finally {
      await daemon.close();
      await probe.close();
    }
  });
});

test("reload with changed browser config replaces Chrome and commits the new config", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const probe = await startCdpProbe();
    config.cdpPort = probe.port;
    const requested = { ...config, headless: false };
    const ensureConfigs: HostConfig[] = [];
    let killCount = 0;
    const daemon = await startDaemon({
      config,
      ensureChrome: async (received) => {
        ensureConfigs.push({ ...received });
        return {
          pid: 42,
          cdpPort: received.cdpPort,
          userDataDir: received.userDataDir,
          async kill() {
            killCount++;
          },
        };
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
      await probe.close();
    }
  });
});

test("reload failure keeps the previous browser config", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const probe = await startCdpProbe();
    config.cdpPort = probe.port;
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
        return {
          pid: 42,
          cdpPort: config.cdpPort,
          userDataDir: config.userDataDir,
          async kill() {},
        };
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
      await probe.close();
    }
  });
});

test("reload rejects when attached browser shutdown leaves the old CDP endpoint alive", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const probe = await startCdpProbe();
    config.cdpPort = probe.port;
    const requested = { ...config, headless: false };
    let ensureCount = 0;
    let closeRequests = 0;
    const daemon = await startDaemon({
      config,
      browserShutdownTimeoutMs: 50,
      ensureChrome: async () => {
        ensureCount++;
        return {
          pid: 0,
          cdpPort: config.cdpPort,
          userDataDir: config.userDataDir,
          async kill() {},
        };
      },
      connectCdp: async () => ({
        ...fakeCdp(),
        async send(method: string) {
          if (method === "Browser.close") {
            closeRequests++;
            throw new Error("CDP transport closed before reply");
          }
          return {};
        },
      }),
    });
    try {
      await assert.rejects(
        () => rpcCall(daemon.socketPath, "reload", { config: requested }),
        (err: any) => err.error_code === "EGO_BROWSER_UNAVAILABLE",
      );
      assert.equal(closeRequests, 1);
      assert.equal(ensureCount, 1, "must not attach to the still-live old endpoint");
      assert.equal(daemon.config.headless, true);
    } finally {
      await daemon.close();
      await probe.close();
    }
  });
});

test("reload waits for delayed attached browser shutdown before ensuring replacement", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const probe = await startCdpProbe();
    config.cdpPort = probe.port;
    const requested = { ...config, headless: false };
    let ensureCount = 0;
    let closeRequests = 0;
    let oldEndpointClosed = false;
    const daemon = await startDaemon({
      config,
      browserShutdownTimeoutMs: 500,
      ensureChrome: async (received) => {
        ensureCount++;
        if (ensureCount === 2) {
          assert.equal(
            oldEndpointClosed,
            true,
            "replacement started before old CDP endpoint stopped",
          );
        }
        return {
          pid: ensureCount === 1 ? 0 : 42,
          cdpPort: received.cdpPort,
          userDataDir: received.userDataDir,
          async kill() {},
        };
      },
      connectCdp: async () => ({
        ...fakeCdp(),
        async send(method: string) {
          if (method === "Browser.close") {
            closeRequests++;
            setTimeout(() => {
              void probe.close().then(() => {
                oldEndpointClosed = true;
              });
            }, 25);
            throw new Error("CDP transport closed before reply");
          }
          return {};
        },
      }),
    });
    try {
      await rpcCall(daemon.socketPath, "reload", { config: requested });
      assert.equal(closeRequests, 1);
      assert.equal(ensureCount, 2);
      assert.equal(daemon.config.headless, false);
    } finally {
      await daemon.close();
      await probe.close();
    }
  });
});

test("reload serializes an ego request until the new browser lifecycle is ready", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const probe = await startCdpProbe();
    config.cdpPort = probe.port;
    const requested = { ...config, headless: false };
    const killStarted = deferred();
    const releaseKill = deferred();
    const oldBridgeUsed = deferred();
    let ensureCount = 0;
    let connectCount = 0;
    let oldListCalls = 0;

    const daemon = await startDaemon({
      config,
      ensureChrome: async (received) => {
        ensureCount++;
        return {
          pid: ensureCount === 1 ? 42 : 43,
          cdpPort: received.cdpPort,
          userDataDir: received.userDataDir,
          async kill() {
            killStarted.resolve();
            await releaseKill.promise;
          },
        };
      },
      connectCdp: async () => {
        connectCount++;
        if (connectCount > 1) return fakeCdp();
        return {
          ...fakeCdp(),
          async listPageTargets() {
            oldListCalls++;
            if (oldListCalls > 1) oldBridgeUsed.resolve();
            return [];
          },
        };
      },
    });
    try {
      const reloadPromise = rpcCall(
        daemon.socketPath,
        "reload",
        { config: requested },
        1,
      );
      await killStarted.promise;
      const egoPromise = rpcCall(
        daemon.socketPath,
        "ego.listTabs",
        undefined,
        2,
      );
      const interleaved = await Promise.race([
        oldBridgeUsed.promise.then(() => true),
        delay(75).then(() => false),
      ]);
      releaseKill.resolve();
      const [reloadResult, tabs] = await Promise.all([
        reloadPromise,
        egoPromise,
      ]);

      assert.equal(interleaved, false, "ego request used the bridge being replaced");
      assert.deepEqual(reloadResult, { ok: true });
      assert.deepEqual(tabs, { tabs: [] });
      assert.equal(oldListCalls, 1, "only startup may use the old bridge");
      assert.equal(ensureCount, 2);
      assert.equal(connectCount, 2);
    } finally {
      releaseKill.resolve();
      await daemon.close();
      await probe.close();
    }
  });
});

test("successful reload commits only browser launch configuration", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const probe = await startCdpProbe();
    config.cdpPort = probe.port;
    const originalMetadata = {
      hostSocket: config.hostSocket,
      dataDir: config.dataDir,
      seedFromChrome: config.seedFromChrome,
    };
    const requested: HostConfig = {
      ...config,
      headless: false,
      hostSocket: join(dir, "ignored-host.sock"),
      dataDir: join(dir, "ignored-data"),
      seedFromChrome: true,
    };
    const daemon = await startDaemon({
      config,
      ensureChrome: async (received) => ({
        pid: 42,
        cdpPort: received.cdpPort,
        userDataDir: received.userDataDir,
        async kill() {},
      }),
      connectCdp: async () => fakeCdp(),
    });
    try {
      await rpcCall(daemon.socketPath, "reload", { config: requested });
      assert.equal(daemon.config.headless, false);
      assert.deepEqual(
        {
          hostSocket: daemon.config.hostSocket,
          dataDir: daemon.config.dataDir,
          seedFromChrome: daemon.config.seedFromChrome,
        },
        originalMetadata,
      );
    } finally {
      await daemon.close();
      await probe.close();
    }
  });
});
