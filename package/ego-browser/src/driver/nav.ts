import {
  browserEgo,
  clearPreferredTarget,
  ensureSession,
  invalidateSession,
  isBrowserRuntime,
  pendingDialog,
  setPreferredTarget,
} from "../browser-runtime.js";
import { cdp, evaluate } from "../cdp-eval.js";
import { assertNoEgoError } from "../ego-errors.js";
import { state } from "../state.js";
import { waitForDocumentLoad } from "./load.js";

export const INTERNAL_URL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "chrome-extension://",
  "about:",
];

type TabInfo = {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
  index?: number;
};

type GotoOptions = {
  waitUntil?: "load" | "domcontentloaded" | "commit";
  timeout?: number;
  settle?: number;
};

type ListTabsOptions = {
  includeChrome?: boolean;
};

type UrlMatchMode = "exact" | "origin" | "origin+path" | "includes";

type OpenOrReuseTabOptions = {
  match?: UrlMatchMode;
  wait?: boolean;
  timeout?: number;
  settle?: number;
  reload?: boolean;
};

type TabTarget = string | { targetId: string };

/**
 * Navigate the current tab to a URL and, by default, wait for it to load.
 * @param {string} url Absolute or browser-supported URL to load.
 * @param {{waitUntil?: "load"|"domcontentloaded"|"commit", timeout?: number, settle?: number}} [options]
 *   `waitUntil: "commit"` returns once navigation is issued without waiting for the document to load.
 *   `timeout` and `settle` are in milliseconds.
 * @returns {Promise<{navigation: object, loaded: boolean}>}
 */
export async function goto(url: string, options: GotoOptions = {}) {
  try {
    new URL(url);
  } catch {
    throw new Error(
      `page.goto needs an absolute URL with a scheme; received ${JSON.stringify(url)}. Write "https://${String(url).replace(/^\/+/, "")}" or use browser.openOrReuseTab(url).`,
    );
  }
  const navigation = await cdp("Page.navigate", { url });
  const loaded =
    options.waitUntil === "commit"
      ? false
      : await waitForDocumentLoad({
          timeout: options.timeout ?? 20000,
          until:
            options.waitUntil === "domcontentloaded"
              ? "domcontentloaded"
              : "load",
        });
  const settle = Number(options.settle ?? 0);
  if (settle > 0) {
    await state.sleep(settle);
  }
  return { navigation, loaded };
}

/**
 * Read basic state for the current page.
 * @returns {Promise<{url:string,title:string,w:number,h:number,sx:number,sy:number,pw:number,ph:number}|{dialog:object}>}
 */
export async function pageInfo() {
  if (isBrowserRuntime()) {
    await ensureSession();
    const dialog = pendingDialog();
    if (dialog) {
      return { dialog };
    }
  }
  const expression = `(() => {
    const root = document.documentElement;
    return JSON.stringify({
      url: location.href,
      title: document.title,
      w: innerWidth,
      h: innerHeight,
      sx: scrollX,
      sy: scrollY,
      pw: root?.scrollWidth ?? innerWidth,
      ph: root?.scrollHeight ?? innerHeight,
    });
  })()`;
  return JSON.parse(await evaluate(expression));
}

/**
 * List open page targets known to the browser.
 * @param {{includeChrome?: boolean}} [options]
 * @returns {Promise<Array<{targetId:string,title:string,url:string}>>}
 */
export async function listTabs(
  options: ListTabsOptions = {},
): Promise<TabInfo[]> {
  const includeChrome = options.includeChrome ?? true;
  const result = assertNoEgoError(await browserEgo().listTabs(), "listTabs");
  const tabs = result.tabs || [];
  return tabs
    .filter(
      (tab) =>
        includeChrome ||
        !INTERNAL_URL_PREFIXES.some((prefix) =>
          (tab.url || "").startsWith(prefix),
        ),
    )
    .map((tab) => ({
      targetId: tab.targetId,
      title: tab.title || "",
      url: tab.url || "",
      active: Boolean(tab.active),
      index: tab.index,
    }));
}

/**
 * Return the currently attached tab.
 * @returns {Promise<{targetId:string,url:string,title:string}>}
 */
export async function currentTab() {
  const tabs = await listTabs();
  const active = tabs.find((tab) => tab.active) || tabs[0];
  if (!active) {
    throw new Error("no active browser tab");
  }
  return { targetId: active.targetId, url: active.url, title: active.title };
}

/**
 * Activate an existing tab target.
 * @param {string|{targetId:string}} target Target id or tab-like object.
 * @returns {Promise<string>} Target id.
 */
export async function switchTab(target: string | { targetId: string }) {
  const targetId = targetIdFrom(target, "switchTab");
  const tabs = await listTabs();
  currentTargetFrom(tabs, targetId, "switchTab");
  await cdp("Target.activateTarget", { targetId });
  invalidateSession();
  setPreferredTarget(targetId);
  return targetId;
}

/**
 * Open a new tab and optionally navigate it.
 * @param {string} [url="about:blank"] URL to open.
 * @returns {Promise<string>} New target id.
 */
export async function newTab(url = "about:blank") {
  const result = assertNoEgoError(await browserEgo().createTab(url), "newTab");
  if (!result.targetId) {
    throw new Error("newTab returned no targetId");
  }
  // The CLI path never goes through installEgoSdk's createTab wrapper, so the
  // new tab must become `page` here, for every caller.
  invalidateSession();
  setPreferredTarget(result.targetId);
  return result.targetId;
}

/**
 * Reuse an existing matching tab or open a new one. By default, matching is
 * done by origin so a site gets one agent tab even when its path/query changes;
 * a reused tab is navigated to `url` when it is on a different URL.
 * @param {string} url URL to find or open.
 * @param {{match?: "exact"|"origin"|"origin+path"|"includes", wait?: boolean, timeout?: number, settle?: number, reload?: boolean}} [options]
 *   Reusing a tab already on `url` keeps the page exactly as it is, including
 *   anything a previous script changed in the DOM. Pass `reload: true` for a
 *   clean copy of the page.
 * @returns {Promise<{targetId:string,url:string,title:string,active:boolean,index?:number,reused:boolean}>}
 */
export async function openOrReuseTab(
  url: string,
  options: OpenOrReuseTabOptions = {},
) {
  // Without this an empty string spent the whole timeout and then reported
  // "waiting for  to load".
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(
      `openOrReuseTab requires a URL; received ${JSON.stringify(url)}`,
    );
  }
  try {
    new URL(url);
  } catch {
    throw new Error(
      `openOrReuseTab requires an absolute URL (with a scheme); received ${JSON.stringify(url)}`,
    );
  }
  const tabs = await listTabs({ includeChrome: false });
  const match = options.match || "origin";
  // Reuse never leaves the selected task space: listTabs() is already scoped to
  // it, and taking a tab from another agent's space would silently hand this
  // script someone else's page (and empty their space).
  const reusable = tabs.find((tab) => tabMatchesUrl(tab.url, url, match));
  if (reusable) {
    await switchTab(reusable.targetId);
    if (tabMatchesUrl(reusable.url, url, "exact") && !options.reload) {
      if (options.wait) {
        assertLoaded(
          await waitForDocumentLoad({ timeout: options.timeout ?? 20000 }),
          url,
          options.timeout ?? 20000,
        );
      }
    } else {
      // Reuse is about the tab, not the page: a same-origin tab on another
      // path still has to end up on the requested URL.
      const { loaded } = await goto(url, {
        timeout: options.timeout ?? 20000,
        waitUntil: options.wait === false ? "commit" : "load",
      });
      if (options.wait !== false) {
        assertLoaded(loaded, url, options.timeout ?? 20000);
      }
    }
    const settle = Number(options.settle ?? 0);
    if (settle > 0) {
      await state.sleep(settle);
    }
    return { ...reusable, url, active: true, reused: true };
  }

  const targetId = await newTab(url);
  if (options.wait !== false) {
    assertLoaded(
      await waitForDocumentLoad({ timeout: options.timeout ?? 20000 }),
      url,
      options.timeout ?? 20000,
    );
  }
  const settle = Number(options.settle ?? 0);
  if (settle > 0) {
    await state.sleep(settle);
  }
  return { targetId, url, title: "", active: true, reused: false };
}

/**
 * Close a browser tab by target id, tab object, or the current tab when omitted.
 * @param {string|{targetId:string}} [target] Target id or tab-like object. Defaults to the current tab.
 * @returns {Promise<string>} Closed target id.
 */
export async function closeTab(target: TabTarget | undefined = undefined) {
  const tabs = await listTabs();
  const targetId =
    target === undefined
      ? (tabs.find((tab) => tab.active) || tabs[0])?.targetId
      : targetIdFrom(target, "closeTab");
  if (!targetId) throw new Error("closeTab requires a targetId");
  currentTargetFrom(tabs, targetId, "closeTab");
  await cdp("Target.closeTarget", { targetId });
  invalidateSession();
  if (state.preferredTargetId === targetId) {
    clearPreferredTarget();
  }
  if (tabs.length > 1) {
    await waitForClosedTarget(targetId);
  }
  return targetId;
}

/**
 * Ensure the active harness session points at a real, non-internal page tab.
 * @returns {Promise<{targetId:string,title:string,url:string}|null>}
 */
export async function ensureRealTab() {
  const tabs = await listTabs({ includeChrome: false });
  if (tabs.length === 0) {
    return null;
  }
  const current = await currentTab().catch(() => null);
  if (
    current?.url &&
    !INTERNAL_URL_PREFIXES.some((prefix) => current.url.startsWith(prefix))
  ) {
    return current;
  }
  await switchTab(tabs[0].targetId);
  return tabs[0];
}

/**
 * Go back one entry in this tab's history.
 * @param {{timeout?: number, waitUntil?: "load"|"domcontentloaded"|"commit"}} [options]
 * @returns {Promise<{url:string, loaded:boolean}|null>} Null when there is nothing to go back to.
 */
export async function goBack(options: GotoOptions = {}) {
  return await historyGo(-1, options);
}

/**
 * Go forward one entry in this tab's history.
 * @param {{timeout?: number, waitUntil?: "load"|"domcontentloaded"|"commit"}} [options]
 * @returns {Promise<{url:string, loaded:boolean}|null>} Null when there is nothing to go forward to.
 */
export async function goForward(options: GotoOptions = {}) {
  return await historyGo(1, options);
}

async function historyGo(delta: number, options: GotoOptions) {
  const history = await cdp("Page.getNavigationHistory");
  const entries = history?.entries || [];
  const index = Number(history?.currentIndex ?? -1) + delta;
  const entry = entries[index];
  if (!entry) return null;
  await cdp("Page.navigateToHistoryEntry", { entryId: entry.id });
  const loaded =
    options.waitUntil === "commit"
      ? false
      : await waitForDocumentLoad({
          timeout: options.timeout ?? 20000,
          until:
            options.waitUntil === "domcontentloaded"
              ? "domcontentloaded"
              : "load",
        });
  return { url: String(entry.url || ""), loaded };
}

/**
 * Resize the viewport of the current tab. Headless Chrome starts at 800x600,
 * which hides responsive controls (a site's search box can collapse to 0x0 and
 * drop out of the accessibility tree entirely).
 * @param {{width:number,height:number,deviceScaleFactor?:number,mobile?:boolean}} size Viewport size in CSS pixels.
 * @returns {Promise<{width:number,height:number}>} The applied size.
 */
export async function setViewportSize(size: {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
}) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(
      `page.setViewportSize requires { width, height } in CSS pixels; received ${JSON.stringify(size)}`,
    );
  }
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: Math.round(width),
    height: Math.round(height),
    deviceScaleFactor: Number(size?.deviceScaleFactor ?? 1),
    mobile: Boolean(size?.mobile ?? false),
  });
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Find an iframe target whose URL contains a substring.
 * @param {string} urlSubstring URL substring to match.
 * @returns {Promise<string|null>} Matching iframe target id, if any.
 */
export async function iframeTarget(urlSubstring) {
  const targets = (await cdp("Target.getTargets")).targetInfos || [];
  return (
    targets.find(
      (target) =>
        target.type === "iframe" && (target.url || "").includes(urlSubstring),
    )?.targetId || null
  );
}

/** A wait the caller asked for and did not get is a failure, not a result. */
function assertLoaded(loaded: boolean, url: string, timeout: number) {
  if (!loaded) {
    throw new Error(
      `timed out after ${timeout}ms waiting for ${url} to load; the tab is still on the previous page`,
    );
  }
}

function tabMatchesUrl(tabUrl: string, wantedUrl: string, match: UrlMatchMode) {
  if (!tabUrl) {
    return false;
  }
  if (match === "includes") {
    return tabUrl.includes(wantedUrl);
  }
  let tab;
  let wanted;
  try {
    tab = new URL(tabUrl);
    wanted = new URL(wantedUrl);
  } catch {
    return tabUrl === wantedUrl;
  }
  if (match === "origin") {
    return tab.origin === wanted.origin;
  }
  if (match === "origin+path") {
    return (
      tab.origin === wanted.origin &&
      trimSlash(tab.pathname) === trimSlash(wanted.pathname)
    );
  }
  return tab.href === wanted.href;
}

function trimSlash(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

function targetIdFrom(target: TabTarget, operation: string) {
  const targetId =
    typeof target === "string"
      ? target
      : target && typeof target === "object"
        ? target.targetId
        : undefined;
  if (typeof targetId !== "string" || !targetId) {
    throw new Error(
      `${operation} requires a targetId; received ${JSON.stringify(target)}`,
    );
  }
  return targetId;
}

function currentTargetFrom(
  tabs: TabInfo[],
  targetId: string,
  operation: string,
) {
  const tab = tabs.find((candidate) => candidate.targetId === targetId);
  if (tab) return tab;
  const available = tabs.map(({ targetId, title, url }) => ({
    targetId,
    title,
    url,
  }));
  throw new Error(
    `${operation} target not found: ${JSON.stringify(targetId)}. ` +
      `Refresh browser.listTabs() and select a current targetId. ` +
      `Available tabs: ${JSON.stringify(available)}`,
  );
}

async function waitForClosedTarget(targetId: string) {
  const deadline = state.now() + 2000;
  while (true) {
    const tabs = await listTabs();
    if (!tabs.some((tab) => tab.targetId === targetId)) return tabs;
    if (state.now() >= deadline) {
      throw new Error(
        `closeTab timed out waiting for target to close: ${JSON.stringify(targetId)}`,
      );
    }
    await state.sleep(50);
  }
}
