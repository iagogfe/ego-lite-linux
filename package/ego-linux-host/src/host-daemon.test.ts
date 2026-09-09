import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createDaemonLog, startDaemon, HOST_VERSION } from "./host-daemon.js";
import { connectHost } from "./ego-client.js";
import { decodeLine, encodeLine, isRpcResponse, LineBuffer } from "./rpc.js";
import type { HostConfig } from "./config.js";
import type { CdpBridge } from "./cdp-bridge.js";
import { SpaceManager } from "./space-manager.js";

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
      sock.write(encodeLine({ id, method, params }));
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
  };
}

function fakeCdp(): CdpBridge {
  return {
    async send() {
      return {};
    },
    sendRaw() {},
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

test("daemon starts without restoring selection and reconciles persisted tabs", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    config.cdpPort = 1;
    const spacesPath = join(dir, "spaces.json");
    const seed = new SpaceManager(spacesPath);
    const oldSpace = seed.createAgentSpace("old-job");
    seed.use(oldSpace.id);
    seed.assignTarget("live-agent-tab");
    seed.assignTarget("closed-agent-tab");
    await seed.save();

    const pages = [
      {
        targetId: "live-agent-tab",
        title: "Live",
        url: "https://agent.example",
        type: "page",
      },
      {
        targetId: "new-user-tab",
        title: "New user tab",
        url: "https://user.example",
        type: "page",
      },
    ];
    const daemon = await startDaemon({
      config,
      spacesPath,
      ensureChrome: async () => ({
        pid: 0,
        cdpPort: config.cdpPort,
        userDataDir: config.userDataDir,
        path: null,
        async kill() {},
      }),
      connectCdp: async () => ({
        ...fakeCdp(),
        async listPageTargets() {
          return pages;
        },
      }),
    });
    try {
      assert.equal(daemon.spaceManager.selected(), null);
      assert.deepEqual(
        daemon.spaceManager.list().find((space) => space.id === oldSpace.id)
          ?.targetIds,
        ["live-agent-tab"],
      );
      assert.deepEqual(
        daemon.spaceManager.list().find((space) => space.id === 1)?.targetIds,
        ["new-user-tab"],
      );
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

test("a second daemon on a live socket stands down instead of binding over it", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const first = await startDaemon({ config, skipChrome: true });
    let stoodDown = false;
    try {
      const second = await startDaemon({
        config: { ...config },
        skipChrome: true,
        writePid: false,
        onAlreadyRunning: () => {
          stoodDown = true;
          // Stand in for process.exit(0) so the test runner survives.
          throw new Error("stand down");
        },
      }).catch((err) => err as Error);
      // Without the guard the second daemon binds and would hold the runner open.
      if (!(second instanceof Error)) await second.close();

      assert.equal(
        stoodDown,
        true,
        "second daemon must detect the live socket",
      );
      assert.equal((second as Error).message, "stand down");
      // The live socket file must survive, and its owner must still answer.
      assert.equal(existsSync(config.hostSocket), true);
      const ping = await rpcCall(first.socketPath, "ping");
      assert.equal(ping.ok, true);
    } finally {
      await first.close();
    }
  });
});

test("host.log records lifecycle events and no per-request traffic", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const logPath = join(dir, "host.log");
    const daemon = await startDaemon({ config, skipChrome: true });
    await rpcCall(daemon.socketPath, "ego.listTaskSpaces");
    await rpcCall(daemon.socketPath, "ego.createTaskSpace", { name: "work" });
    await daemon.close();

    const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
    assert.ok(
      lines.some((l) => l.includes("daemon listening")),
      "a restart must be explainable",
    );
    assert.ok(lines.some((l) => l.includes("daemon stopping")));
    // Every line carries a timestamp, and none names an RPC method.
    for (const line of lines) {
      assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /);
      assert.equal(
        line.includes("ego."),
        false,
        `traffic leaked into the log: ${line}`,
      );
    }
    assert.ok(lines.length <= 4, `log is chatty: ${lines.length} lines`);
  });
});

test("createDaemonLog truncates a log that grew past the cap", async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, "host.log");
    await writeFile(logPath, "x".repeat(1_000_001), "utf8");

    const log = createDaemonLog(dir);
    log("after rotation");

    const written = await readFile(logPath, "utf8");
    assert.ok(written.endsWith("after rotation\n"));
    assert.ok(written.length < 200, "old content must be gone");
  });
});

test("a slow ego call on one session does not block another session", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const slow = deferred();
    const daemon = await startDaemon({
      config,
      connectCdp: async () => ({
        ...fakeCdp(),
        isOpen: () => true,
        async send(method: string) {
          // The heavy call of one session (a big page's AX tree) hangs.
          if (method === "Accessibility.getFullAXTree") {
            await slow.promise;
            return { nodes: [] };
          }
          return {};
        },
        async listPageTargets() {
          return [
            {
              targetId: "t-slow",
              title: "slow",
              url: "https://slow.test",
              type: "page",
            },
          ];
        },
      }),
      ensureChrome: async () => ({
        pid: 0,
        cdpPort: config.cdpPort,
        userDataDir: config.userDataDir,
        path: null,
        async kill() {},
      }),
    });
    const space = daemon.spaceManager.createAgentSpace("slow-space");
    daemon.spaceManager.assignTarget("t-slow", space.id);

    const c1 = await connectHost(daemon.socketPath);
    const c2 = await connectHost(daemon.socketPath);
    try {
      await c1.request("ego.useTaskSpace", { id: space.id });
      const hanging = c1.request("ego.snapshot", {});
      let hangingSettled = false;
      void hanging.then(
        () => (hangingSettled = true),
        () => (hangingSettled = true),
      );
      await delay(50);

      // The second client must be served while the first is still stuck.
      // Raced against a deadline: serialized, this request never answers.
      const spaces = await Promise.race([
        c2.request("ego.listTaskSpaces"),
        delay(2000).then(() => "blocked" as const),
      ]);
      assert.notEqual(
        spaces,
        "blocked",
        "a second session was blocked behind the slow one",
      );
      assert.ok(Array.isArray(spaces.taskSpaces));
      assert.equal(
        hangingSettled,
        false,
        "the slow call should still be in flight",
      );

      slow.resolve();
      await hanging.catch(() => undefined);
    } finally {
      c1.close();
      c2.close();
      await daemon.close();
    }
  });
});

test("a disconnecting client does not keep the focus lease", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const daemon = await startDaemon({
      config,
      connectCdp: async () => ({
        ...fakeCdp(),
        isOpen: () => true,
        async send(method: string) {
          return method === "Accessibility.getFullAXTree" ? { nodes: [] } : {};
        },
        async listPageTargets() {
          return [
            {
              targetId: "t-leave",
              title: "t",
              url: "https://x.test",
              type: "page",
            },
          ];
        },
      }),
      ensureChrome: async () => ({
        pid: 0,
        cdpPort: config.cdpPort,
        userDataDir: config.userDataDir,
        path: null,
        async kill() {},
      }),
    });
    const space = daemon.spaceManager.createAgentSpace("leaver-space");
    daemon.spaceManager.assignTarget("t-leave", space.id);
    try {
      // A client takes the focus lease with an AX read, then its process exits.
      const leaver = await connectHost(daemon.socketPath);
      await leaver.request("ego.useTaskSpace", { id: space.id });
      await leaver.request("ego.sendCDPMessage", {
        payload: JSON.stringify({
          id: 3,
          method: "Accessibility.getFullAXTree",
        }),
      });
      leaver.close();
      await delay(50);

      // The next client must be served without waiting out the lease deadline.
      const next = await connectHost(daemon.socketPath);
      try {
        await next.request("ego.useTaskSpace", { id: space.id });
        const t = Date.now();
        const served = await Promise.race([
          next.request("ego.snapshot", {}),
          delay(1500).then(() => "stuck" as const),
        ]);
        assert.notEqual(served, "stuck", "lease stayed with a gone client");
        assert.ok(Date.now() - t < 1000);
      } finally {
        next.close();
      }
    } finally {
      await daemon.close();
    }
  });
});

test("concurrent connections keep their own task space selection", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    let created = 0;
    const daemon = await startDaemon({
      config,
      connectCdp: async () => ({
        ...fakeCdp(),
        isOpen: () => true,
        async createTarget() {
          return `target-${++created}`;
        },
      }),
      ensureChrome: async () => ({
        pid: 0,
        cdpPort: config.cdpPort,
        userDataDir: config.userDataDir,
        path: null,
        async kill() {},
      }),
    });
    daemon.spaceManager.createAgentSpace("p1");
    daemon.spaceManager.createAgentSpace("p2");
    const [p1, p2] = daemon.spaceManager
      .list()
      .filter((s) => s.name === "p1" || s.name === "p2");
    // Two live connections, the way two ego-browser processes look to the host.
    const c1 = await connectHost(daemon.socketPath);
    const c2 = await connectHost(daemon.socketPath);
    try {
      // Interleaved exactly like the race: both select, then both create a tab.
      await c1.request("ego.useTaskSpace", { id: p1.id });
      await c2.request("ego.useTaskSpace", { id: p2.id });
      const t1 = await c1.request("ego.createTab", { url: "https://a.test/" });
      const t2 = await c2.request("ego.createTab", { url: "https://b.test/" });

      const spaces = daemon.spaceManager.list();
      assert.deepEqual(
        spaces.find((s) => s.id === p1.id)?.targetIds,
        [t1.targetId],
        "connection 1's tab must stay in the space connection 1 selected",
      );
      assert.deepEqual(spaces.find((s) => s.id === p2.id)?.targetIds, [
        t2.targetId,
      ]);
    } finally {
      c1.close();
      c2.close();
      await daemon.close();
    }
  });
});

test("daemon reconnects the CDP bridge when its websocket closed while Chrome stayed up", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const probe = await startCdpProbe();
    config.cdpPort = probe.port;
    let connectCount = 0;
    let firstBridgeOpen = true;
    const daemon = await startDaemon({
      config,
      ensureChrome: async () => ({
        pid: 0,
        cdpPort: config.cdpPort,
        userDataDir: config.userDataDir,
        path: null,
        async kill() {},
      }),
      connectCdp: async () => {
        const n = ++connectCount;
        return { ...fakeCdp(), isOpen: () => n > 1 || firstBridgeOpen };
      },
    });
    try {
      assert.equal(connectCount, 1);
      // e.g. an oversized CDP reply dropped the websocket; CDP itself still answers.
      firstBridgeOpen = false;
      const tabs = await rpcCall(daemon.socketPath, "ego.listTabs");
      assert.ok(Array.isArray(tabs.tabs));
      assert.equal(
        connectCount,
        2,
        "closed bridge must be replaced instead of reused",
      );
    } finally {
      await daemon.close();
      await probe.close();
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
          path: "/usr/bin/google-chrome",
          async kill() {},
        };
      },
      connectCdp: async () => ({
        async send() {
          return {};
        },
        sendRaw() {},
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
            path: null,
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

test("doctor reporta o binario em uso, nao so o configurado", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir); // chromePath: null, como numa maquina sem config
    const daemon = await startDaemon({
      config,
      // host resolveu o Chrome pelo PATH: o handle sabe qual binario subiu
      ensureChrome: async () => ({
        pid: 4242,
        cdpPort: config.cdpPort,
        userDataDir: config.userDataDir,
        path: "/usr/bin/google-chrome",
        async kill() {},
      }),
      connectCdp: async () => ({
        async send() {
          return {};
        },
        sendRaw() {},
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
      const doctor = await rpcCall(daemon.socketPath, "doctor");
      // reportar null aqui dizia "sem Chrome" com o browser rodando ao lado
      assert.equal(doctor.chromePath, "/usr/bin/google-chrome");
      assert.equal(doctor.chromePid, 4242);
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
          path: "/usr/bin/google-chrome",
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
          path: "/usr/bin/google-chrome",
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
          path: "/usr/bin/google-chrome",
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
          path: "/usr/bin/google-chrome",
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
      assert.equal(
        ensureCount,
        1,
        "must not attach to the still-live old endpoint",
      );
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
          path: "/usr/bin/google-chrome",
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
          path: "/usr/bin/google-chrome",
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

      assert.equal(
        interleaved,
        false,
        "ego request used the bridge being replaced",
      );
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
    };
    const requested: HostConfig = {
      ...config,
      headless: false,
      hostSocket: join(dir, "ignored-host.sock"),
      dataDir: join(dir, "ignored-data"),
    };
    const daemon = await startDaemon({
      config,
      ensureChrome: async (received) => ({
        pid: 42,
        cdpPort: received.cdpPort,
        userDataDir: received.userDataDir,
        path: "/usr/bin/google-chrome",
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
        },
        originalMetadata,
      );
    } finally {
      await daemon.close();
      await probe.close();
    }
  });
});
