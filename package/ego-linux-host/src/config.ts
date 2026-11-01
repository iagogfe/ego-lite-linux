import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultCdpPort,
  defaultConfigDir,
  defaultDataDir,
  defaultProfileDir,
  defaultSocketPath,
} from "./paths.js";

/**
 * How a headless browser presents itself to sites.
 * - `real` (default): launch with a non-headless Chrome UA, the requested
 *   language, and without the AutomationControlled Blink feature, so a site
 *   does not see a headless Chromium that answers JS like no person does.
 * - `strict`: the launch line upstream shipped before; kept for A/B checks.
 */
export type HeadlessIdentity = "real" | "strict";

export type HostConfig = {
  chromePath: string | null;
  userDataDir: string;
  cdpPort: number;
  headless: boolean;
  hostSocket: string;
  dataDir: string;
  /** Idle time before an agent task space's tabs are closed (ms). */
  agentSpaceTtlMs?: number;
  /** Headless identity mode; undefined means `real`. */
  headlessIdentity?: HeadlessIdentity;
  /** UI language (`--lang`) for the headless browser; undefined means locale of the env. */
  lang?: string;
  /** `--accept-lang` value; undefined means derived from `lang`. */
  acceptLang?: string;
  /** `TZ` for the spawned browser; null/undefined inherits the daemon's. */
  timezone?: string | null;
  /** Explicit `--user-agent`; undefined means derived from the Chrome binary. */
  userAgent?: string | null;
};

/** Optional fields from ~/.config/ego-lite/config.json */
type FileConfig = {
  chromePath?: string | null;
  userDataDir?: string;
  cdpPort?: number;
  headless?: boolean;
  hostSocket?: string;
};

function configFilePath(env: NodeJS.ProcessEnv): string {
  return join(defaultConfigDir(env), "config.json");
}

async function readFileConfig(env: NodeJS.ProcessEnv): Promise<FileConfig> {
  const path = configFilePath(env);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as FileConfig;
    }
    return {};
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw err;
  }
}

function parseTruthy(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = raw.toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return Boolean(raw);
}

/**
 * Normalize a locale for `--lang`: `zh_CN.UTF-8@modifier` → `zh-CN`.
 * Returns null for values Chrome would not accept as a BCP-47 tag.
 */
export function normalizeLocale(raw: string | undefined): string | null {
  if (!raw) return null;
  const tag = raw.split("@")[0].split(".")[0].replace(/_/g, "-");
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return null;
  const [language, ...rest] = tag.split("-");
  return [
    language.toLowerCase(),
    ...rest.map((part) =>
      part.length === 2 ? part.toUpperCase() : part.toLowerCase(),
    ),
  ].join("-");
}

/** Locale from the process environment, in the order glibc resolves it. */
export function localeFromEnv(env: NodeJS.ProcessEnv): string | null {
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const normalized = normalizeLocale(env[key]);
    if (normalized && normalized !== "c" && normalized !== "posix") {
      return normalized;
    }
  }
  return null;
}

/**
 * Accept-Language for a locale: `zh-CN` → `zh-CN,zh,en`.
 * The language tag, its base language, and English (when not the base).
 */
export function deriveAcceptLang(lang: string): string {
  const base = lang.split("-")[0];
  const parts = [lang];
  if (base.toLowerCase() !== lang.toLowerCase()) parts.push(base);
  if (base.toLowerCase() !== "en") parts.push("en");
  return parts.join(",");
}

/**
 * Load host config: defaults from paths, optional config.json, env overrides.
 * Precedence: env > file > path defaults.
 */
export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostConfig> {
  const file = await readFileConfig(env);

  const dataDir = defaultDataDir(env);

  let chromePath: string | null;
  if (env.EGO_CHROME_PATH !== undefined && env.EGO_CHROME_PATH !== "") {
    chromePath = env.EGO_CHROME_PATH;
  } else if (file.chromePath !== undefined) {
    chromePath = file.chromePath;
  } else {
    chromePath = null;
  }

  let userDataDir: string;
  if (env.EGO_USER_DATA_DIR) {
    userDataDir = env.EGO_USER_DATA_DIR;
  } else if (file.userDataDir) {
    userDataDir = file.userDataDir;
  } else {
    userDataDir = defaultProfileDir(env);
  }

  let cdpPort: number;
  if (env.EGO_CDP_PORT) {
    cdpPort = Number(env.EGO_CDP_PORT);
  } else if (file.cdpPort !== undefined) {
    cdpPort = Number(file.cdpPort);
  } else {
    cdpPort = defaultCdpPort(env);
  }

  const headlessEnv = parseTruthy(env.EGO_HEADLESS);
  const headless =
    headlessEnv !== undefined ? headlessEnv : (file.headless ?? false);

  let hostSocket: string;
  if (env.EGO_HOST_SOCK) {
    hostSocket = env.EGO_HOST_SOCK;
  } else if (file.hostSocket) {
    hostSocket = file.hostSocket;
  } else {
    hostSocket = defaultSocketPath(env);
  }

  const ttlRaw = Number(env.EGO_AGENT_SPACE_TTL_MS);

  // A headless browser that reports HeadlessChrome in its UA is turned away by
  // site risk controls even though navigator.webdriver is already false.
  // `real` hides that tell at launch, so every tab and every respawn inherits
  // it; `strict` keeps the old launch line for A/B comparison.
  const headlessIdentity: HeadlessIdentity =
    (env.EGO_HEADLESS_IDENTITY ?? "").toLowerCase() === "strict"
      ? "strict"
      : "real";
  const lang = normalizeLocale(env.EGO_LANG) ?? localeFromEnv(env) ?? "en-US";
  const acceptLang = env.EGO_ACCEPT_LANG?.trim() || deriveAcceptLang(lang);

  return {
    chromePath,
    userDataDir,
    cdpPort,
    headless,
    hostSocket,
    dataDir,
    headlessIdentity,
    lang,
    acceptLang,
    timezone: env.EGO_TZ?.trim() || null,
    userAgent: env.EGO_USER_AGENT?.trim() || null,
    ...(Number.isFinite(ttlRaw) && env.EGO_AGENT_SPACE_TTL_MS
      ? { agentSpaceTtlMs: ttlRaw }
      : {}),
  };
}
