/**
 * Long-lived ego Linux host daemon.
 *
 * - Ensures Chrome + CDP on start
 * - Owns SpaceManager + EgoRuntime
 * - Serves NDJSON RPC on a Unix domain socket
 */

import { createServer, type Server, type Socket } from "node:net";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { connectCdp, type CdpBridge } from "./cdp-bridge.js";
import {
  ensureChrome,
  isCdpUp,
  type ChromeHandle,
} from "./chrome-supervisor.js";
import { loadConfig, type HostConfig } from "./config.js";
import { createEgoRuntime, type EgoRuntime } from "./ego-runtime.js";
import { makeEgoError } from "./errors.js";
import {
  decodeLine,
  encodeEvent,
  encodeResponse,
  isRpcRequest,
  LineBuffer,
  type RpcEvent,
  type RpcResponse,
} from "./rpc.js";
import { SpaceManager } from "./space-manager.js";

export const HOST_VERSION = "0.1.0";

const BROWSER_SHUTDOWN_TIMEOUT_MS = 3000;
const BROWSER_SHUTDOWN_POLL_MS = 25;

const BROWSER_CONFIG_KEYS = [
  "chromePath",
  "userDataDir",
  "cdpPort",
  "headless",
] as const;

type BrowserConfig = Pick<
  HostConfig,
  (typeof BROWSER_CONFIG_KEYS)[number]
>;

export type HostDaemonOptions = {
  config?: HostConfig;
  env?: NodeJS.ProcessEnv;
  /** Skip real Chrome/CDP (unit/integration tests). */
  skipChrome?: boolean;
  /** Inject CDP bridge factory (defaults to connectCdp). */
  connectCdp?: (port: number) => Promise<CdpBridge>;
  /** Inject Chrome ensure (defaults to ensureChrome). */
  ensureChrome?: (config: HostConfig) => Promise<ChromeHandle>;
  /** Override attached-browser shutdown confirmation timeout (tests). */
  browserShutdownTimeoutMs?: number;
  /** Override spaces.json path. */
  spacesPath?: string;
  /** Override pid file path. */
  pidPath?: string;
  /** Listen without writing pid (tests). */
  writePid?: boolean;
};

export type HostDaemon = {
  socketPath: string;
  config: HostConfig;
  spaceManager: SpaceManager;
  runtime: EgoRuntime;
  close(): Promise<void>;
};

function errorToRpc(
  id: number,
  err: unknown,
): RpcResponse {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const spacesPath =
    options.spacesPath ?? join(dataDir, "spaces.json");
  const pidPath = options.pidPath ?? join(dataDir, "host.pid");
  const socketPath = config.hostSocket;

  const spaceManager = new SpaceManager(spacesPath);
  await spaceManager.load();

  const ensureChromeFn = options.ensureChrome ?? ensureChrome;
  const connectCdpFn = options.connectCdp ?? connectCdp;
  const browserShutdownTimeoutMs =
    options.browserShutdownTimeoutMs ?? BROWSER_SHUTDOWN_TIMEOUT_MS;

  let chrome: ChromeHandle | null = null;
  let cdp: CdpBridge | null = null;
  let chromeStartupError: string | null = null;

  if (!options.skipChrome) {
    try {
      chrome = await ensureChromeFn(config);
      cdp = await connectCdpFn(config.cdpPort);
      // Adopt orphan page targets into user space
      try {
        const pages = await cdp.listPageTargets();
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

    if (cdp && (await isCdpUp(config.cdpPort))) {
      return;
    }

    await closeCdpBridge();

    try {
      // ensureChrome attaches if CDP is already back, otherwise respawns Chrome.
      chrome = await ensureChromeFn(config);
      cdp = await connectCdpFn(config.cdpPort);
      detachForward = runtime.attachCdpForwarding();
      chromeStartupError = null;
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
  let lifecycleTail: Promise<void> = Promise.resolve();

  function serializeBrowserLifecycle<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = lifecycleTail.then(operation, operation);
    lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function handleRequest(
    method: string,
    params: any,
  ): Promise<any> {
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
        cdp = await connectCdpFn(requestedConfig.cdpPort);
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
    throw makeEgoError(
      "EGO_INVALID_ARGUMENT",
      `unknown RPC method: ${method}`,
    );
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
    const line = encodeEvent(ev);
    for (const socket of clients) {
      writeToClient(socket, line);
    }
  }

  runtime.onEvent(broadcastEvent);

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await safeUnlink(socketPath);

  const server: Server = createServer((socket) => {
    clients.add(socket);
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
            const result =
              msg.method === "reload" || msg.method.startsWith("ego.")
                ? await serializeBrowserLifecycle(() =>
                    handleRequest(msg.method, msg.params),
                  )
                : await handleRequest(msg.method, msg.params);
            writeToClient(socket, encodeResponse({ id, result }));
          } catch (err) {
            if (id >= 0) {
              writeToClient(socket, encodeResponse(errorToRpc(id, err)));
            }
          }
        })();
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
    socket.on("error", () => {
      clients.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  if (options.writePid !== false) {
    await writeFile(pidPath, String(process.pid), "utf8");
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
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
  const chromePid = chrome?.pid ?? null;
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
