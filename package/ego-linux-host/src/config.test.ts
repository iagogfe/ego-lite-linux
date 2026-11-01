import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.js";

test("loadConfig honors EGO_HEADLESS and EGO_CDP_PORT", async () => {
  const cfg = await loadConfig({
    EGO_DATA_DIR: "/tmp/ego-cfg-test",
    EGO_HEADLESS: "1",
    EGO_CDP_PORT: "9444",
  });
  assert.equal(cfg.headless, true);
  assert.equal(cfg.cdpPort, 9444);
  assert.equal(cfg.userDataDir, "/tmp/ego-cfg-test/profile");
});

test("loadConfig defaults are headed, cdp 9222, null chromePath", async () => {
  const cfg = await loadConfig({
    EGO_DATA_DIR: "/tmp/ego-cfg-defaults",
    EGO_CONFIG_DIR: "/tmp/ego-cfg-defaults-missing-config",
  });
  assert.equal(cfg.headless, false);
  assert.equal(cfg.cdpPort, 9222);
  assert.equal(cfg.chromePath, null);
  assert.equal(cfg.dataDir, "/tmp/ego-cfg-defaults");
  assert.equal(cfg.hostSocket, "/tmp/ego-cfg-defaults/host.sock");
});

test("loadConfig env wins over config.json", async () => {
  const base = join(tmpdir(), `ego-cfg-env-wins-${process.pid}`);
  const configDir = join(base, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      headless: false,
      cdpPort: 1111,
      chromePath: "/from/file",
      hostSocket: "/from/file.sock",
      userDataDir: "/from/file/profile",
    }),
  );
  try {
    const cfg = await loadConfig({
      EGO_CONFIG_DIR: configDir,
      EGO_DATA_DIR: "/tmp/ego-cfg-env-wins-data",
      EGO_HEADLESS: "1",
      EGO_CDP_PORT: "9444",
      EGO_CHROME_PATH: "/from/env",
      EGO_HOST_SOCK: "/from/env.sock",
      EGO_USER_DATA_DIR: "/from/env/profile",
    });
    assert.equal(cfg.headless, true);
    assert.equal(cfg.cdpPort, 9444);
    assert.equal(cfg.chromePath, "/from/env");
    assert.equal(cfg.hostSocket, "/from/env.sock");
    assert.equal(cfg.userDataDir, "/from/env/profile");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("loadConfig reads optional config.json when env absent", async () => {
  const base = join(tmpdir(), `ego-cfg-file-${process.pid}`);
  const configDir = join(base, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      headless: true,
      cdpPort: 9333,
      chromePath: "/usr/bin/chromium",
      hostSocket: "/tmp/custom.sock",
      userDataDir: "/tmp/custom-profile",
    }),
  );
  try {
    const cfg = await loadConfig({
      EGO_CONFIG_DIR: configDir,
      EGO_DATA_DIR: "/tmp/ego-cfg-file-data",
    });
    assert.equal(cfg.headless, true);
    assert.equal(cfg.cdpPort, 9333);
    assert.equal(cfg.chromePath, "/usr/bin/chromium");
    assert.equal(cfg.hostSocket, "/tmp/custom.sock");
    assert.equal(cfg.userDataDir, "/tmp/custom-profile");
    assert.equal(cfg.dataDir, "/tmp/ego-cfg-file-data");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("loadConfig defaults headless identity to real with locale-derived language", async () => {
  const cfg = await loadConfig({
    EGO_CONFIG_DIR: "/tmp/ego-cfg-identity-missing",
    EGO_DATA_DIR: "/tmp/ego-cfg-identity",
    LANG: "zh_CN.UTF-8",
  });
  assert.equal(cfg.headlessIdentity, "real");
  assert.equal(cfg.lang, "zh-CN");
  assert.equal(cfg.acceptLang, "zh-CN,zh,en");
  assert.equal(cfg.timezone, null);
  assert.equal(cfg.userAgent, null);
});

test("loadConfig honors EGO_HEADLESS_IDENTITY, EGO_LANG, EGO_ACCEPT_LANG, EGO_TZ, EGO_USER_AGENT", async () => {
  const cfg = await loadConfig({
    EGO_CONFIG_DIR: "/tmp/ego-cfg-identity-missing",
    EGO_DATA_DIR: "/tmp/ego-cfg-identity-env",
    LANG: "en_US.UTF-8",
    EGO_HEADLESS_IDENTITY: "strict",
    EGO_LANG: "ja-JP",
    EGO_ACCEPT_LANG: "ja-JP,ja;q=0.9,en;q=0.8",
    EGO_TZ: "Asia/Tokyo",
    EGO_USER_AGENT: "Mozilla/5.0 (X11; Linux x86_64) Test/1.0",
  });
  assert.equal(cfg.headlessIdentity, "strict");
  assert.equal(cfg.lang, "ja-JP");
  assert.equal(cfg.acceptLang, "ja-JP,ja;q=0.9,en;q=0.8");
  assert.equal(cfg.timezone, "Asia/Tokyo");
  assert.equal(cfg.userAgent, "Mozilla/5.0 (X11; Linux x86_64) Test/1.0");
});

test("loadConfig falls back to en-US when the environment carries no locale", async () => {
  const cfg = await loadConfig({
    EGO_CONFIG_DIR: "/tmp/ego-cfg-identity-missing",
    EGO_DATA_DIR: "/tmp/ego-cfg-identity-fallback",
  });
  assert.equal(cfg.lang, "en-US");
  assert.equal(cfg.acceptLang, "en-US,en");
});
