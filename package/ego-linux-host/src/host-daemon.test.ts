import test from "node:test";
import assert from "node:assert/strict";
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
    const daemon = await startDaemon({
      config: testConfig(dir),
      skipChrome: true,
    });
    try {
      const doctor = await rpcCall(daemon.socketPath, "doctor");
      assert.equal(doctor.ok, true);
      assert.equal(doctor.version, HOST_VERSION);
      assert.equal(doctor.socketPath, daemon.socketPath);
      assert.equal(doctor.cdpUp, false);
      assert.ok(doctor.spaceCount >= 1);

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
