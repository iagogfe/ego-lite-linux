/**
 * Long-lived ego Linux host daemon.
 *
 * - Ensures Chrome + CDP on start
 * - Owns SpaceManager + EgoRuntime
 * - Serves NDJSON RPC on a Unix domain socket
 */

import { createServer, type Server, type Socket } from "node:net";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  truncateSync,
} from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pingSocket } from "./ego-client.js";
import { setTimeout as sleep } from "node:timers/promises";
import { connectCdp, preloadWs, type CdpBridge } from "./cdp-bridge.js";
import {
  AGENT_VIEWPORT,
  ensureChrome,
  isCdpUp,
  type ChromeHandle,
  type EnsureChromeOptions,
} from "./chrome-supervisor.js";
import { loadConfig, type HostConfig } from "./config.js";
import { createEgoRuntime, type EgoRuntime } from "./ego-runtime.js";
import { makeEgoError } from "./errors.js";
import {
  decodeLine,
  encodeLine,
  isRpcRequest,
  LineBuffer,
  type RpcEvent,
  type RpcResponse,
} from "./rpc.js";
import { SpaceManager } from "./space-manager.js";

// Read rather than hardcode: this is what --doctor, the client handshake and
// the status payload report, and a literal only stays right while someone
// remembers to bump it. Nobody did for 0.2.0, which shipped reporting 0.1.0.
export const HOST_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const BROWSER_SHUTDOWN_TIMEOUT_MS = 3000;
const BROWSER_SHUTDOWN_POLL_MS = 25;

const BROWSER_CONFIG_KEYS = [
  "chromePath",
  "userDataDir",
  "cdpPort",
  "headless",
] as const;

type BrowserConfig = Pick<HostConfig, (typeof BROWSER_CONFIG_KEYS)[number]>;

export type HostDaemonOptions = {
  config?: HostConfig;
  env?: NodeJS.ProcessEnv;
  /** Skip real Chrome/CDP (unit/integration tests). */
  skipChrome?: boolean;
  /** Inject CDP bridge factory (defaults to connectCdp). */
  connectCdp?: (
    port: number,
    webSocketDebuggerUrl?: string | null,
  ) => Promise<CdpBridge>;
  /** Inject Chrome ensure (defaults to ensureChrome). */
  ensureChrome?: (
    config: HostConfig,
    options?: EnsureChromeOptions,
  ) => Promise<ChromeHandle>;
  /** Override attached-browser shutdown confirmation timeout (tests). */
  browserShutdownTimeoutMs?: number;
  /** Override spaces.json path. */
  spacesPath?: string;
  /** Override pid file path. */
  pidPath?: string;
  /** Listen without writing pid (tests). */
  writePid?: boolean;
  /**
   * What to do when another daemon already serves the socket.
   * Defaults to exiting quietly: a losing daemon is expected, not a crash.
   */
  onAlreadyRunning?: () => never | Promise<never>;
};

export type HostDaemon = {
  socketPath: string;
  config: HostConfig;
  spaceManager: SpaceManager;
  runtime: EgoRuntime;
  close(): Promise<void>;
};

/** Truncated at this size on daemon start; lifecycle lines only, so it crawls. */
const LOG_MAX_BYTES = 1_000_000;

/**
 * Operational log: one line per lifecycle event, never per request.
 *
 * It answers the two questions a user asks when the host misbehaves — why did
 * the daemon restart, and why did my tab disappear — and nothing else. Traffic
 * would drown both. Writes to the file rather than stdout so the record exists
 * whether the daemon was spawned by the CLI or started by hand.
 */
export function createDaemonLog(dataDir: string): (line: string) => void {
  const logPath = join(dataDir, "host.log");
  try {
    if (statSync(logPath).size > LOG_MAX_BYTES) truncateSync(logPath, 0);
  } catch {
    // No log yet, or not readable: nothing to rotate.
  }
  return (line: string) => {
    try {
      // ponytail: one line per event, so newlines in a value would forge one.
      const safe = line.replace(/[\r\n]+/g, " ");
      appendFileSync(logPath, `${new Date().toISOString()} ${safe}\n`);
    } catch {
      // Diagnostics must never take the host down.
    }
  };
}

function errorToRpc(id: number, err: unknown): RpcResponse {
  const code =
    err &&
    typeof err === "object" &&
    typeof (err as { error_code?: string }).error_code === "string"
      ? (err as { error_code: string }).error_code
      : "EGO_OPERATION_FAILED";
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);
  return { id, error: { code, message } };
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") throw err;
  }
}

function browserConfigChanged(
  current: HostConfig,
  requested: HostConfig,
): boolean {
  return BROWSER_CONFIG_KEYS.some((key) => current[key] !== requested[key]);
}

function browserConfig(config: HostConfig): BrowserConfig {
  return {
    chromePath: config.chromePath,
    userDataDir: config.userDataDir,
    cdpPort: config.cdpPort,
    headless: config.headless,
  };
}

/**
 * Start the host daemon: config → chrome → CDP → spaces → Unix socket.
 */
export async function startDaemon(
  options: HostDaemonOptions = {},
): Promise<HostDaemon> {
  const env = options.env ?? process.env;
  const config = options.config ?? (await loadConfig(env));
  const dataDir = config.dataDir;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const log = createDaemonLog(dataDir);
  const alreadyRunning =
    options.onAlreadyRunning ?? (() => process.exit(0) as never);
  const spacesPath = options.spacesPath ?? join(dataDir, "spaces.json");
  const pidPath = options.pidPath ?? join(dataDir, "host.pid");
  const socketPath = config.hostSocket;

  const spaceManager = new SpaceManager(spacesPath);
  await spaceManager.load();
  // A daemon restart starts a fresh agent invocation. The task spaces remain
  // available by name/id, but an abandoned selection must not become active
  // before the new invocation explicitly chooses one.
  spaceManager.clearSelection();

  const ensureChromeFn = options.ensureChrome ?? ensureChrome;
  const connectCdpFn = options.connectCdp ?? connectCdp;
  const browserShutdownTimeoutMs =
    options.browserShutdownTimeoutMs ?? BROWSER_SHUTDOWN_TIMEOUT_MS;

  let chrome: ChromeHandle | null = null;
  let cdp: CdpBridge | null = null;
  let chromeStartupError: string | null = null;

  if (!options.skipChrome) {
    try {
      chrome = await ensureChromeFn(config, {
        onSpawn: () => void preloadWs(),
      });
      log(
        chrome.pid > 0
          ? `chrome spawned pid=${chrome.pid} port=${config.cdpPort}`
          : `chrome attached port=${config.cdpPort} (already running)`,
      );
      cdp = await connectCdpFn(config.cdpPort, chrome.webSocketDebuggerUrl);
      // Adopt orphan page targets into user space
      try {
        const pages = await cdp.listPageTargets();
        spaceManager.reconcileTargets(pages.map((p) => p.targetId));
        const pruned = spaceManager.pruneEmptyAgentSpaces();
        if (pruned > 0) log(`pruned ${pruned} empty agent task space(s)`);
        spaceManager.adoptOrphanTargets(pages.map((p) => p.targetId));
        await spaceManager.save();
      } catch {
        // non-fatal on startup
      }
    } catch (err) {
      // Starting without a browser is not fatal: --doctor exists to diagnose
      // exactly this case, and dying here left the CLI with a socket timeout
      // that never mentioned Chrome. ensureBrowserReady retries on the next
      // ego method, same path a mid-session Chrome death takes.
      chromeStartupError = err instanceof Error ? err.message : String(err);
      log(`chrome unavailable: ${chromeStartupError}`);
      chrome = null;
      cdp = null;
    }
  } else {
    // Minimal stub so getCdp never throws before a real inject
    cdp = {
      async send() {
        throw makeEgoError(
          "EGO_CDP_CHANNEL_UNAVAILABLE",
          "CDP not connected (skipChrome)",
        );
      },
      sendRaw() {
        throw makeEgoError(
          "EGO_CDP_CHANNEL_UNAVAILABLE",
          "CDP not connected (skipChrome)",
        );
      },
      onMessage() {
        return () => {};
      },
      async close() {},
      async listPageTargets() {
        return [];
      },
      async createTarget() {
        throw makeEgoError(
          "EGO_CDP_CHANNEL_UNAVAILABLE",
          "CDP not connected (skipChrome)",
        );
      },
      async attach() {
        throw makeEgoError(
          "EGO_CDP_CHANNEL_UNAVAILABLE",
          "CDP not connected (skipChrome)",
        );
      },
    };
  }

  const getCdp = () => {
    if (!cdp) {
      throw makeEgoError(
        "EGO_CDP_CHANNEL_UNAVAILABLE",
        "CDP bridge not available",
      );
    }
    return cdp;
  };

  const ensureSession = async (): Promise<string> => {
    const bridge = getCdp();
    const allowed = new Set(spaceManager.targetsForSelected());
    const pages = await bridge.listPageTargets();
    const inSpace = pages.filter((p) => allowed.has(p.targetId));
    const active = inSpace[inSpace.length - 1];
    if (!active) {
      throw makeEgoError(
        "EGO_WEB_CONTENTS_UNAVAILABLE",
        "no tab in selected task space to attach",
      );
    }
    return bridge.attach(active.targetId);
  };

  const runtime = createEgoRuntime({
    spaceManager,
    getCdp,
    ensureSession,
    version: HOST_VERSION,
    ...(config.agentSpaceTtlMs !== undefined
      ? { staleSpaceTtlMs: config.agentSpaceTtlMs }
      : {}),
    // Headed inherits the size of the user's own window.
    ...(config.headless ? { viewport: AGENT_VIEWPORT } : {}),
    log,
  });

  let detachForward: (() => void) | undefined;
  if (!options.skipChrome && cdp) {
    detachForward = runtime.attachCdpForwarding();
  }

  async function closeCdpBridge(): Promise<void> {
    if (detachForward) {
      detachForward();
      detachForward = undefined;
    }
    if (cdp) {
      try {
        await cdp.close();
      } catch {
        // Ignore transport errors while disconnecting a bridge.
      }
      cdp = null;
    }
  }

  async function shutdownBrowser(): Promise<void> {
    const previousChrome = chrome;
    const previousCdp = cdp;
    if (detachForward) {
      detachForward();
      detachForward = undefined;
    }

    try {
      if (previousChrome && previousChrome.pid > 0) {
        await previousChrome.kill();
      } else if (previousCdp) {
        let closeError: unknown;
        try {
          void previousCdp.send("Browser.close").catch((err) => {
            // The transport normally drops before Browser.close can reply.
            closeError = err;
          });
        } catch (err) {
          closeError = err;
        }

        const port = previousChrome?.cdpPort ?? config.cdpPort;
        const deadline = Date.now() + browserShutdownTimeoutMs;
        while (await isCdpUp(port)) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            const detail = closeError
              ? `: ${closeError instanceof Error ? closeError.message : String(closeError)}`
              : "";
            throw makeEgoError(
              "EGO_BROWSER_UNAVAILABLE",
              `Attached browser did not stop within ${browserShutdownTimeoutMs}ms${detail}`,
            );
          }
          await sleep(Math.min(BROWSER_SHUTDOWN_POLL_MS, remaining));
        }
      }
    } finally {
      if (previousCdp) {
        try {
          await previousCdp.close();
        } catch {
          // Browser shutdown can close the transport before the bridge does.
        }
      }
      chrome = null;
      cdp = null;
    }
  }

  function throwReloadBrowserUnavailable(err: unknown): never {
    const code =
      err &&
      typeof err === "object" &&
      typeof (err as { error_code?: string }).error_code === "string"
        ? (err as { error_code: string }).error_code
        : undefined;
    if (code === "EGO_BROWSER_UNAVAILABLE") throw err;
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : String(err);
    throw makeEgoError(
      "EGO_BROWSER_UNAVAILABLE",
      `Browser/CDP unavailable after reload: ${message}`,
    );
  }

  async function reconnectBrowser(): Promise<void> {
    await closeCdpBridge();
    if (options.skipChrome) return;

    try {
      if (!(await isCdpUp(config.cdpPort))) {
        chrome = await ensureChromeFn(config);
      }
      cdp = await connectCdpFn(config.cdpPort);
      detachForward = runtime.attachCdpForwarding();
      chromeStartupError = null;
    } catch (err) {
      throwReloadBrowserUnavailable(err);
    }
  }

  /**
   * If Chrome/CDP died, respawn via ensureChrome and reconnect the bridge.
   * Ego methods call this so a dead browser surfaces as a clear
   * EGO_BROWSER_UNAVAILABLE (or recovers when spawn succeeds).
   */
  async function ensureBrowserReady(): Promise<void> {
    if (options.skipChrome) return;

    // An open WebSocket is the liveness signal; the HTTP probe is the fallback
    // for bridges that cannot report it (~1-10ms per call on Chrome's side).
    if (cdp && (cdp.isOpen ? cdp.isOpen() : await isCdpUp(config.cdpPort))) {
      return;
    }

    await closeCdpBridge();

    try {
      // ensureChrome attaches if CDP is already back, otherwise respawns Chrome.
      chrome = await ensureChromeFn(config);
      cdp = await connectCdpFn(config.cdpPort, chrome.webSocketDebuggerUrl);
      detachForward = runtime.attachCdpForwarding();
      chromeStartupError = null;
      log(
        chrome.pid > 0
          ? `browser reconnected: chrome respawned pid=${chrome.pid}`
          : "browser reconnected: cdp bridge replaced",
      );
    } catch (err) {
      const code =
        err &&
        typeof err === "object" &&
        typeof (err as { error_code?: string }).error_code === "string"
          ? (err as { error_code: string }).error_code
          : undefined;
      if (code === "EGO_BROWSER_UNAVAILABLE") throw err;
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : String(err);
      throw makeEgoError(
        "EGO_BROWSER_UNAVAILABLE",
        `Browser/CDP unavailable: ${message}. Chrome may have exited; the host will try to respawn on the next request.`,
      );
    }
  }

  const clients = new Set<Socket>();
  const clientSockets = new Map<string, Socket>();
  // Browser-swap gate: `reload` is the writer, every ego.* call is a reader.
  let swapTail: Promise<unknown> = Promise.resolve();
  let swapping = false;
  let active = 0;
  let onDrained: (() => void) | undefined;

  /**
   * ego.* calls run concurrently: they address independent CDP sessions, and
   * one slow page must not hold the others. Serializing them made every client
   * wait out the slowest — a snapshot that hit the 15s CDP timeout stalled
   * every other client by 15s, once per client.
   *
   * They are only held back by a browser swap (`reload`), which replaces
   * Chrome and the bridge underneath them.
   */
  async function runConcurrent<T>(operation: () => Promise<T>): Promise<T> {
    while (swapping) {
      await swapTail.catch(() => undefined);
    }
    // No await between the check and the increment: a swap cannot slip in.
    active++;
    try {
      return await operation();
    } finally {
      if (--active === 0) onDrained?.();
    }
  }

  /** `reload` swaps Chrome/CDP, so it waits for in-flight calls and runs alone. */
  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      swapping = true;
      try {
        if (active > 0) {
          await new Promise<void>((resolve) => {
            onDrained = resolve;
          });
          onDrained = undefined;
        }
        return await operation();
      } finally {
        swapping = false;
      }
    };
    const result = swapTail.then(run, run);
    swapTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function handleRequest(method: string, params: any): Promise<any> {
    if (method === "ping") {
      return { ok: true, version: HOST_VERSION };
    }
    if (method === "doctor") {
      return buildDoctor(
        config,
        chrome,
        spaceManager,
        socketPath,
        chromeStartupError,
      );
    }
    if (method === "reload") {
      const requestedConfig = params?.config as HostConfig | undefined;
      if (!requestedConfig || !browserConfigChanged(config, requestedConfig)) {
        await reconnectBrowser();
        return { ok: true };
      }

      const previousBrowserConfig = browserConfig(config);
      let newChrome: ChromeHandle | null = null;
      try {
        await shutdownBrowser();
        newChrome = await ensureChromeFn(requestedConfig);
        chrome = newChrome;
        cdp = await connectCdpFn(
          requestedConfig.cdpPort,
          newChrome.webSocketDebuggerUrl,
        );
        detachForward = runtime.attachCdpForwarding();
        Object.assign(config, browserConfig(requestedConfig));
        chromeStartupError = null;
      } catch (err) {
        if (detachForward) {
          detachForward();
          detachForward = undefined;
        }
        try {
          await cdp?.close();
        } catch {
          // Ignore a partially connected bridge.
        }
        cdp = null;
        if (newChrome) {
          try {
            await newChrome.kill();
          } catch {
            // Preserve the original startup error.
          }
        }
        chrome = null;
        Object.assign(config, previousBrowserConfig);
        throwReloadBrowserUnavailable(err);
      }
      return { ok: true };
    }
    if (method.startsWith("ego.")) {
      await ensureBrowserReady();
      const result = await runtime.handle(method, params ?? {});
      // Persist space mutations (best-effort)
      try {
        await spaceManager.save();
      } catch {
        // ignore
      }
      return result;
    }
    throw makeEgoError("EGO_INVALID_ARGUMENT", `unknown RPC method: ${method}`);
  }

  function writeToClient(socket: Socket, text: string): void {
    if (socket.destroyed) return;
    try {
      socket.write(text);
    } catch {
      // ignore write failures on dead sockets
    }
  }

  function broadcastEvent(ev: RpcEvent): void {
    const { to, ...wire } = ev;
    const line = encodeLine(wire);
    if (to !== undefined) {
      // A CDP response belongs to one connection; the others must not see it.
      const socket = clientSockets.get(to);
      if (socket) writeToClient(socket, line);
      return;
    }
    for (const socket of clients) {
      writeToClient(socket, line);
    }
  }

  runtime.onEvent(broadcastEvent);

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  // A unix socket only reports EADDRINUSE while its file exists, so unlinking
  // first would let this daemon bind over a live one and serve the same path
  // twice. Only a socket that answers nothing gets removed.
  if (existsSync(socketPath)) {
    if (await pingSocket(socketPath, 1000)) {
      process.stderr.write(
        `${new Date().toISOString()} another ego-linux-hostd already serves ${socketPath}; exiting\n`,
      );
      await alreadyRunning();
    }
    await safeUnlink(socketPath);
  }

  let nextClientId = 1;

  const server: Server = createServer((socket) => {
    clients.add(socket);
    // Task-space selection is per connection: one ego-browser process must not
    // see (or overwrite) the space another one selected between two RPCs.
    const clientId = String(nextClientId++);
    clientSockets.set(clientId, socket);
    const lineBuf = new LineBuffer();

    socket.on("data", (chunk) => {
      const lines = lineBuf.push(chunk);
      for (const line of lines) {
        void (async () => {
          let id = -1;
          try {
            const msg = decodeLine(line);
            if (!isRpcRequest(msg)) {
              // ignore non-requests from client
              return;
            }
            id = msg.id;
            const result = await spaceManager.runForClient(clientId, () => {
              const call = () => handleRequest(msg.method, msg.params);
              if (msg.method === "reload") return runExclusive(call);
              if (msg.method.startsWith("ego.")) return runConcurrent(call);
              return call();
            });
            writeToClient(socket, encodeLine({ id, result }));
          } catch (err) {
            if (id >= 0) {
              writeToClient(socket, encodeLine(errorToRpc(id, err)));
            }
          }
        })();
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
      clientSockets.delete(clientId);
      spaceManager.releaseClient(clientId);
      runtime.releaseClient(clientId);
    });
    socket.on("error", () => {
      clients.delete(socket);
      clientSockets.delete(clientId);
      spaceManager.releaseClient(clientId);
      runtime.releaseClient(clientId);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      // Narrow race: the winner created the socket after the check above.
      if (err.code === "EADDRINUSE") {
        process.stderr.write(
          `${new Date().toISOString()} another ego-linux-hostd already serves ${socketPath}; exiting\n`,
        );
        void alreadyRunning();
        return;
      }
      reject(err);
    });
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  log(`daemon listening pid=${process.pid} socket=${socketPath}`);

  if (options.writePid !== false) {
    await writeFile(pidPath, String(process.pid), "utf8");
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    log(`daemon stopping pid=${process.pid}`);
    if (detachForward) {
      detachForward();
      detachForward = undefined;
    }
    for (const s of clients) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    clients.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    // ponytail: no ownership guard here — libuv already unlinks the pipe path
    // inside server.close(), whoever owns the file by then. The defense that
    // works is upstream: never unlink a socket that still answers, so a second
    // daemon never takes this path while this one serves it.
    await safeUnlink(socketPath);
    if (options.writePid !== false) {
      await safeUnlink(pidPath);
    }
    if (cdp) {
      try {
        await cdp.close();
      } catch {
        // ignore
      }
      cdp = null;
    }
    // Do not kill chrome on daemon stop by default — profile may stay warm.
    // Callers that own chrome (tests) can kill via returned handle if needed.
    try {
      await spaceManager.save();
    } catch {
      // ignore
    }
  }

  return {
    socketPath,
    config,
    spaceManager,
    runtime,
    close,
  };
}

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Diagnostic payload for RPC `doctor` / CLI `--doctor`.
 * CLI merges `harnessPath` (resolved on the client) into this object.
 */
async function buildDoctor(
  config: HostConfig,
  chrome: ChromeHandle | null,
  spaceManager: SpaceManager,
  socketPath: string,
  chromeError: string | null = null,
): Promise<Record<string, unknown>> {
  const cdpUp = await isCdpUp(config.cdpPort);
  // pid 0 is the attached case (Chrome was already up, someone else owns it).
  // Reporting 0 read as a fact; null says "not ours", which is what we know.
  const chromePid = chrome && chrome.pid > 0 ? chrome.pid : null;
  const chromeRunning =
    cdpUp || (chromePid != null && isProcessAlive(chromePid));
  const selected = spaceManager.selected();
  return {
    ok: true,
    version: HOST_VERSION,
    // O binario em uso, nao so o configurado: quando o host resolve o Chrome
    // pelo PATH, config.chromePath fica null e o doctor dizia "sem Chrome"
    // com o browser rodando ao lado.
    chromePath: chrome?.path ?? config.chromePath,
    chromeRunning,
    chromePid,
    // Why the browser is missing, when it is. Null when Chrome came up.
    chromeError,
    cdpPort: config.cdpPort,
    cdpUp,
    profileDir: config.userDataDir,
    dataDir: config.dataDir,
    socketPath,
    daemonPid: process.pid,
    spaceCount: spaceManager.list().length,
    selectedSpace: selected
      ? {
          id: selected.id,
          name: selected.name,
          ownership: selected.ownership,
        }
      : null,
    headless: config.headless,
    displayEnv: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    // Resolved by the CLI shim (daemon does not know the harness layout).
    harnessPath: null,
  };
}
