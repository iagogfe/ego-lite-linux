/**
 * AX tree → compact snapshot text + ref map for ego Linux host.
 *
 * Pure serializer (`axTreeToSnapshot`) for fixtures/unit tests.
 * `snapshotPage` loads Accessibility.getFullAXTree via CdpBridge.
 */

import type { CdpBridge } from "./cdp-bridge.js";
import { makeEgoError } from "./errors.js";

export type SnapshotOptions = {
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
  /** Snapshot only this node's subtree (Accessibility.queryAXTree). */
  rootBackendNodeId?: number;
};

export type SnapshotRef = {
  id: number;
  backendNodeId: number;
  role?: string;
  name?: string;
};

export type SnapshotResult = {
  content: string;
  refs: SnapshotRef[];
};

/** Roles worth exposing as actionable / readable snapshot lines. */
const INTERESTING_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "heading",
  "StaticText",
  "image",
  "img",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  // Chrome emits lowercase AX roles; "Row" alone silently dropped every table
  // row, which turned a table into a flat run of cells with no boundaries.
  "row",
  "Row",
  "rowgroup",
  "table",
  "list",
  "code",
  "figure",
  "paragraph",
  "listitem",
  "ListItem",
  "article",
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "form",
  "dialog",
  "alertdialog",
  "alert",
  "status",
  "progressbar",
  "meter",
  "RootWebArea",
]);

/** Structural roles we only keep when they carry a non-empty name. */
const STRUCTURAL_IF_NAMED = new Set([
  "generic",
  "group",
  "none",
  "InlineTextBox",
  "LineBreak",
  "LabelText",
  "LegacyLayout",
]);

function extractAxString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const raw = (value as { value?: unknown }).value;
    if (typeof raw === "string") return raw;
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  }
  return "";
}

function nodeRole(node: any): string {
  return extractAxString(node?.role);
}

function nodeName(node: any): string {
  return extractAxString(node?.name);
}

function nodeBackendId(node: any): number | undefined {
  const id = node?.backendDOMNodeId ?? node?.backendNodeId;
  if (id === undefined || id === null) return undefined;
  const n = Number(id);
  return Number.isFinite(n) ? n : undefined;
}

/** Bullets and numbers rendered by ::marker: a row nothing can read or act on. */
const NOISE_ROLES = new Set(["ListMarker"]);

function isInteresting(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.ignored) return false;
  if (NOISE_ROLES.has(nodeRole(node))) return false;

  const backendNodeId = nodeBackendId(node);
  if (backendNodeId === undefined) return false;

  const role = nodeRole(node);
  const name = nodeName(node).trim();

  if (INTERESTING_ROLES.has(role)) {
    // RootWebArea always kept (page chrome); StaticText needs name
    if (role === "StaticText" || role === "InlineTextBox") {
      return name.length > 0;
    }
    return true;
  }

  if (STRUCTURAL_IF_NAMED.has(role)) {
    return name.length > 0;
  }

  // Unknown role with a name is still useful context
  return name.length > 0;
}

/**
 * A snapshot row is `@N role "name"`, and for a unique role+name pair that is
 * already the locator, so no suffix is printed. When several nodes share the
 * pair, `role:X[name="Y"]` is ambiguous — it throws in strict mode — so the row
 * carries the disambiguated form instead: `loc=role:X[name="Y"] >> nth=k`.
 */
function formatLine(
  refId: number,
  role: string,
  name: string,
  includeActionMarks: boolean,
  locatorSuffix: string | null,
): string {
  const quoted = JSON.stringify(name);
  const line = includeActionMarks
    ? `@${refId} ${role} ${quoted}`
    : `${role} ${quoted}`;
  return locatorSuffix ? `${line} ${locatorSuffix}` : line;
}

/**
 * Index every addressable node by role+name, in the order a role query returns
 * them, so a row can say which of the duplicates it is. Built over all nodes,
 * not just printed rows: the resolver counts the ones the snapshot skips too.
 */
function roleNameIndex(nodes: any[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const node of nodes) {
    if (!node || node.ignored) continue;
    const backendNodeId = nodeBackendId(node);
    if (backendNodeId === undefined) continue;
    const key = `${nodeRole(node)}\u0000${nodeName(node)}`;
    const list = index.get(key);
    if (list) list.push(backendNodeId);
    else index.set(key, [backendNodeId]);
  }
  return index;
}

/**
 * Walk AX nodes; emit compact snapshot lines plus their refs.
 *
 * The `@N` printed on a line is the node's own backendNodeId — the key the
 * harness stores the ref map under and the id `DOM.resolveNode` takes. A
 * separate sequential counter used to be printed instead, so every `@N` either
 * missed or, on a big page where the two ranges overlap, silently resolved to
 * a different element.
 */
/**
 * The `loc=` a row needs, or null when role+name already identifies it.
 * `includeStableLocator` forces the suffix on every row (still disambiguated).
 */
function locatorSuffix(
  index: Map<string, number[]>,
  role: string,
  name: string,
  backendNodeId: number,
  force: boolean,
): string | null {
  const siblings = index.get(`${role}\u0000${name}`) || [];
  const ambiguous = siblings.length > 1;
  if (!ambiguous && !force) return null;
  const base = `loc=role:${role}[name=${JSON.stringify(name)}]`;
  if (!ambiguous) return base;
  const nth = siblings.indexOf(backendNodeId);
  return nth < 0 ? base : `${base} >> nth=${nth}`;
}

export function axTreeToSnapshot(
  axNodes: any[],
  options: SnapshotOptions = {},
): SnapshotResult {
  const includeActionMarks = options.includeActionMarks === true;
  const includeStableLocator = options.includeStableLocator === true;
  const maxResultLength = options.maxResultLength;

  const nodes = Array.isArray(axNodes) ? axNodes : [];
  const lines: string[] = [];
  const refs: SnapshotRef[] = [];
  const index = roleNameIndex(nodes);
  let lastName: string | null = null;

  for (const node of nodes) {
    if (!isInteresting(node)) continue;

    const role = nodeRole(node) || "unknown";
    const name = nodeName(node);
    const backendNodeId = nodeBackendId(node)!;
    const id = backendNodeId;

    // A StaticText child that only repeats its parent's name adds a row and no
    // information; the parent row already carries the text and a usable ref.
    if (role === "StaticText" && name !== "" && name === lastName) continue;
    lastName = name;

    refs.push({ id, backendNodeId, role, name });
    lines.push(
      formatLine(
        id,
        role,
        name,
        includeActionMarks,
        locatorSuffix(index, role, name, backendNodeId, includeStableLocator),
      ),
    );
  }

  let content = lines.join("\n");
  if (
    typeof maxResultLength === "number" &&
    Number.isFinite(maxResultLength) &&
    maxResultLength >= 0 &&
    content.length > maxResultLength
  ) {
    content = content.slice(0, maxResultLength);
  }

  return { content, refs };
}

/**
 * What to do about an accessibility timeout.
 *
 * Measured on this host: Chrome answers accessibility requests for the tab it
 * has ACTIVE. Selecting a task space does not activate its tab, so a read in a
 * background tab hangs — `page.snapshot()` dies at the 15s CDP timeout and
 * `getByRole` takes ~16s, with nothing running in parallel. Activating the tab
 * first turns the same snapshot into ~650ms. A page stuck in a long task or a
 * dead renderer produces the same timeout, so this names the usual cause, not
 * the only one.
 */
function timeoutAdvice(detail: string): string {
  if (!/timeout/i.test(detail) || !/Accessibility\./.test(detail)) return "";
  return (
    ". Chrome answers accessibility requests only for its focused tab; the host takes that focus turn for you, so the" +
    " usual cause left is the page itself — a renderer stuck in a long task, or one that died. Do not probe it another" +
    " way: page.info() and CSS reads go to the same renderer and hang just as long. The host reports a tab that stops" +
    " answering, and the fix it names is to drop the tab (browser.closeTab) and open a fresh one." +
    " Scoping the snapshot to a region or capping maxResultLength does not help: the whole tree is computed either way."
  );
}

/**
 * Fetch full AX tree via CDP and serialize.
 * On any failure throws EGO_SNAPSHOT_FAILED.
 */
export async function snapshotPage(
  cdp: CdpBridge,
  sessionId: string,
  options?: SnapshotOptions,
): Promise<SnapshotResult> {
  try {
    await cdp.send("Accessibility.enable", {}, sessionId);
    let root = options?.rootBackendNodeId;
    if (!Number.isFinite(root)) {
      // The whole page is queryAXTree from the document root, not
      // getFullAXTree: same nodes and same cost, but in document order. The
      // full tree returns internal tree order, which put late-page rows at the
      // top of the snapshot and made "the 12th match" mean two different
      // elements to the snapshot and to the resolver.
      const doc = await cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
      root = doc?.root?.backendNodeId;
    }
    // Scoping to one node's subtree is the difference between reading the
    // section you care about and spending the budget on the site menu.
    const result = Number.isFinite(root)
      ? await cdp.send(
          "Accessibility.queryAXTree",
          { backendNodeId: root },
          sessionId,
        )
      : await cdp.send("Accessibility.getFullAXTree", {}, sessionId);
    const nodes = result?.nodes;
    if (!Array.isArray(nodes)) {
      throw makeEgoError(
        "EGO_SNAPSHOT_FAILED",
        root === undefined
          ? "Accessibility.getFullAXTree returned no nodes array"
          : `Accessibility.queryAXTree returned no nodes array for backendNodeId ${root}`,
      );
    }
    return axTreeToSnapshot(nodes, options);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      (err as { error_code?: string }).error_code === "EGO_SNAPSHOT_FAILED"
    ) {
      throw err;
    }
    const detail =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : String(err);
    throw makeEgoError(
      "EGO_SNAPSHOT_FAILED",
      `Snapshot failed: ${detail}${timeoutAdvice(detail)}`,
    );
  }
}
