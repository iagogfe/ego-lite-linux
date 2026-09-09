import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { state } from "../state.js";
import { cdp, evaluate } from "../cdp-eval.js";
import { pageInfo } from "./nav.js";
import {
  browserEgo,
  browserSnapshotRefsToRefMap,
  drainBrowserEvents,
  ensureSession,
  isBrowserRuntime,
  pendingDialog,
} from "../browser-runtime.js";
import { buildEgoError } from "../ego-errors.js";
import { resolveElementCenter } from "../element-resolver.js";
import { releaseHandle, resolveHandle } from "./element-ops.js";
import { DOCUMENT_TOKEN_JS } from "../ref-map.js";
import {
  browserRefMap,
  ensureRefMapForRef,
  registerSnapshotForRefRefresh,
} from "../ref-state.js";

type SnapshotOptions = {
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
  rootBackendNodeId?: number;
};

type ScreenshotClip = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
};

type ScreenshotOptions = {
  path?: string;
  fullPage?: boolean;
  raw?: boolean;
  clip?: ScreenshotClip;
};

export function drainEvents() {
  return drainBrowserEvents();
}

const SNAPSHOT_OPTIONS = [
  "includeActionMarks",
  "includeStableLocator",
  "maxResultLength",
  "rootBackendNodeId",
];

/** An option nobody reads is a silent no-op; say so instead. */
function assertSnapshotOptions(options: SnapshotOptions) {
  const unknown = Object.keys(options || {}).filter(
    (key) => !SNAPSHOT_OPTIONS.includes(key),
  );
  if (unknown.length) {
    throw new Error(
      `snapshot: unknown option${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => JSON.stringify(k)).join(", ")}. Valid options: ${SNAPSHOT_OPTIONS.join(", ")}.`,
    );
  }
}

export async function snapshotRaw(options: SnapshotOptions = {}) {
  assertSnapshotOptions(options);
  // The cap is applied here, not by the host, for two reasons: the marker has
  // to name how much was dropped (the host slices and says nothing), and refs
  // must keep covering the whole page so a `@N` beyond the cut still resolves.
  const { maxResultLength, ...passThrough } = options;
  options = passThrough;
  let result;
  const startedAt = state.now();
  try {
    result = await browserEgo().snapshot(options);
  } catch (err) {
    // The CDP timeout in the text is the per-request budget; the agent waited
    // for the retries too, and that is the number it is comparing against.
    if (
      err &&
      typeof err === "object" &&
      typeof (err as any).message === "string"
    ) {
      (err as any).message =
        `${(err as any).message} (waited ${state.now() - startedAt}ms)`;
    }
    // ego.snapshot rejects directly (it never resolves with { error }), so it never
    // reached buildEgoError — the single birthplace that records a hard stop for the
    // output sink and swaps native wording for ego-browser's owned guidance. Route the
    // rejection through it so a swallowed snapshot hard stop collapses like every other
    // ego error instead of leaking repeated native text.
    throw buildEgoError(err, "snapshot");
  }
  browserSnapshotRefsToRefMap(browserRefMap, result.refs || []);
  browserRefMap.documentToken = await currentDocumentToken();
  return {
    ...result,
    content: capContent(result.content || "", maxResultLength),
  };
}

/** Context-safe default for the text surface; `0` asks for the whole page. */
const DEFAULT_SNAPSHOT_CHARS = 20000;

/** Room for the shortest honest marker plus a little content. */
const MIN_SNAPSHOT_CAP = 80;

/**
 * Truncate long snapshot content, saying what was left out.
 *
 * Cutting mid-line once produced a half-written ref (`@1812` became `@18`),
 * which resolved to a different element without any error, so the cut always
 * lands on a line boundary. Chars alone also under-report the loss: the cut
 * keeps the top of the document, which is site chrome, so the marker counts
 * rows and headings too.
 */
function capContent(content: string, maxResultLength?: number) {
  const cap = Number(maxResultLength);
  if (cap < 0 || (maxResultLength !== undefined && !Number.isFinite(cap))) {
    throw new Error(
      `snapshot: maxResultLength must be 0 (whole page) or at least ${MIN_SNAPSHOT_CAP}; got ${maxResultLength}`,
    );
  }
  if (!Number.isFinite(cap) || cap === 0 || content.length <= cap)
    return content;
  if (cap < MIN_SNAPSHOT_CAP) {
    throw new Error(
      `snapshot: maxResultLength must be at least ${MIN_SNAPSHOT_CAP} (or 0 for the whole page); got ${cap}. Below that there is no room for content plus the truncation marker.`,
    );
  }
  const rows = countRows(content);
  const headings = countHeadings(content);
  // Two marker lengths, one shape. Whichever leaves more rows wins, so a bigger
  // cap never returns fewer rows than a smaller one (it used to: the long
  // marker ate the whole increase between 326 and 400).
  const long = fitWith(content, cap, (shown) =>
    truncationMarker(shown, content, rows, headings),
  );
  const short = fitWith(content, cap, (shown) =>
    shortMarker(shown, content, rows),
  );
  const longFits = long.shown.length + long.marker.length <= cap;
  const best =
    longFits && countRows(long.shown) >= countRows(short.shown) ? long : short;
  const out = best.shown
    ? best.shown + best.marker
    : best.marker.replace(/^\n/, "");
  // Last resort for a cap that cannot hold even the short marker.
  return out.length <= cap ? out : out.slice(0, cap);
}

/** Cut to a row boundary that leaves room for the marker it produces. */
function fitWith(
  content: string,
  cap: number,
  makeMarker: (shown: string) => string,
) {
  let budget = cap;
  let shown = "";
  let marker = makeMarker("");
  for (let pass = 0; pass < 3; pass++) {
    shown = cutAtRow(content, budget);
    marker = makeMarker(shown);
    if (shown.length + marker.length <= cap) break;
    budget = cap - marker.length;
    if (budget <= 0) {
      shown = "";
      marker = makeMarker("");
      break;
    }
  }
  return { shown, marker };
}

/** Cut on a row boundary, never mid-row (a split ref resolves elsewhere). */
function cutAtRow(content: string, budget: number) {
  const lastBreak = content.lastIndexOf("\n", Math.max(0, budget));
  return lastBreak > 0 ? content.slice(0, lastBreak) : "";
}

/** Same shape as the long marker, short enough for a small budget. */
function shortMarker(shown: string, content: string, rows: number) {
  return `\n[snapshot truncated: ${shown.length} of ${content.length} chars, ${countRows(shown)} of ${rows} rows shown]`;
}

/** The full marker: what was dropped, and the two ways to get more. */
function truncationMarker(
  shown: string,
  content: string,
  rows: number,
  headings: number,
) {
  const shownRows = countRows(shown);
  const shownHeadings = countHeadings(shown);
  const headingNote =
    headings > shownHeadings
      ? `, including ${headings - shownHeadings} of ${headings} heading rows`
      : "";
  return (
    `\n[snapshot truncated: ${shown.length} of ${content.length} chars, ` +
    `${shownRows} of ${rows} rows shown; ${rows - shownRows} rows omitted${headingNote}. ` +
    `Read a region instead: page.getByRole("region", { name }).snapshot() ` +
    `snapshots just that section. Raise maxResultLength (0 = whole page) for everything. ` +
    `@N refs cover the whole page, including the omitted part.]`
  );
}

function countRows(text: string) {
  return text === "" ? 0 : text.split("\n").length;
}

function countHeadings(text: string) {
  return (text.match(/^@?\d*\s*heading /gm) || []).length;
}

registerSnapshotForRefRefresh(() => snapshotRaw());

/**
 * Return snapshot content with agent-friendly defaults. The text surface most
 * agents want; use snapshotRaw when you need the structured { content, refs }.
 * @param {{includeActionMarks?: boolean, includeStableLocator?: boolean, maxResultLength?: number}} [options]
 *   `maxResultLength` caps the content and defaults to 20000 characters, because
 *   a real article runs ~500K chars (~124K tokens) and would blow the context
 *   window on the first observation. Pass `0` for the whole page. Truncation
 *   only affects the text: `@N` refs always cover the whole page.
 * @returns {Promise<string>}
 */
export async function snapshot(options: SnapshotOptions = {}) {
  const result = await snapshotRaw({
    ...options,
    maxResultLength: options.maxResultLength ?? DEFAULT_SNAPSHOT_CHARS,
    includeActionMarks: options.includeActionMarks ?? true,
    // The row itself is the locator (see SKILL.md); the suffix is opt-in.
    includeStableLocator: options.includeStableLocator ?? false,
  });
  return result.content || "";
}

/**
 * Snapshot only the subtree of one element. The page-wide snapshot spends its
 * budget on site chrome; this reads the region you already located.
 * @param {string} selectorOrRef Selector, `@N` ref, or `loc=` locator for the subtree root.
 * @param {{includeActionMarks?: boolean, includeStableLocator?: boolean, maxResultLength?: number}} [options]
 * @returns {Promise<string>} Snapshot text for that subtree.
 */
export async function snapshotLocator(
  selectorOrRef: string,
  options: SnapshotOptions = {},
) {
  assertSnapshotOptions(options);
  const handle = await resolveHandle(selectorOrRef);
  let rootBackendNodeId;
  try {
    const described = await cdp(
      "DOM.describeNode",
      { objectId: handle.objectId },
      handle.sessionId,
    );
    rootBackendNodeId = described?.node?.backendNodeId;
  } finally {
    await releaseHandle(handle.objectId, handle.sessionId);
  }
  if (!rootBackendNodeId) {
    throw new Error(
      `locator.snapshot: could not resolve a node id for ${selectorOrRef}`,
    );
  }
  const { maxResultLength, ...passThrough } = options;
  const result = await browserEgo().snapshot({
    ...passThrough,
    includeActionMarks: options.includeActionMarks ?? true,
    includeStableLocator: options.includeStableLocator ?? false,
    rootBackendNodeId,
  });
  // Merge: a subtree snapshot must not invalidate the page-wide refs.
  browserSnapshotRefsToRefMap(browserRefMap, result.refs || [], true);
  browserRefMap.documentToken = await currentDocumentToken();
  return capContent(
    result.content || "",
    maxResultLength ?? DEFAULT_SNAPSHOT_CHARS,
  );
}

/** Token of the document currently loaded in the attached tab. */
async function currentDocumentToken(): Promise<string | null> {
  try {
    const value = await evaluate(DOCUMENT_TOKEN_JS);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function elementCenter(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return await resolveElementCenter(
    { sendRaw: cdp },
    undefined,
    browserRefMap,
    selectorOrRef,
  );
}

// Sequence number for default screenshot file names. Combined with the pid it
// keeps concurrent agent processes (parallel task spaces) from overwriting each
// other's shots in the shared tmpdir, and successive shots in one run distinct.
let screenshotSeq = 0;

export async function screenshot(options: ScreenshotOptions = {}) {
  const path =
    options.path ??
    join(tmpdir(), `ego-browser-shot-${process.pid}-${++screenshotSeq}.png`);
  const full = options.fullPage ?? false;
  const raw = options.raw ?? false;
  const params: any = {
    format: "png",
    captureBeyondViewport: full,
  };
  if (raw) {
    if (options.clip) {
      params.clip = { ...options.clip };
    }
  } else {
    if (isBrowserRuntime()) {
      await ensureSession();
    }
    if (!pendingDialog()) {
      const dpr = Number(await evaluate("window.devicePixelRatio")) || 1;
      const cssScale = 1 / dpr;
      if (options.clip) {
        params.clip = { scale: cssScale, ...options.clip };
      } else {
        const info = await pageInfo();
        if ("dialog" in info) {
          return screenshot({ ...options, path, raw: true });
        }
        params.clip = {
          x: 0,
          y: 0,
          width: full ? info.pw : info.w,
          height: full ? info.ph : info.h,
          scale: cssScale,
        };
      }
    }
  }
  const result = await cdp("Page.captureScreenshot", params);
  await mkdir(dirname(path), { recursive: true });
  await state.writeFile(path, Buffer.from(result.data, "base64"));
  return path;
}
