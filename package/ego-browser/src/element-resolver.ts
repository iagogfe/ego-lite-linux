import {
  DOCUMENT_TOKEN_JS,
  invalidRefMessage,
  parseRef,
  refFromOtherDocumentMessage,
} from "./ref-map.js";
import {
  assertKnownRole,
  describeSelector,
  queryAllExpression,
} from "./locator-query.js";

export class ElementResolutionError extends Error {
  kind: "transient" | "permanent";
  constructor(message: string, kind: "transient" | "permanent") {
    super(message);
    this.name = "ElementResolutionError";
    this.kind = kind;
  }
}

/**
 * Return the ordered AX backend-node match set for a root role locator.
 * Non-role selectors return null so callers can use their normal DOM path.
 */
export async function queryRoleLocatorBackendNodeIds(
  cdp,
  sessionId,
  selectorOrRef,
): Promise<number[] | null> {
  const locator = parseLocator(selectorOrRef);
  if (locator?.kind !== "role") {
    return null;
  }
  const backendNodeIds = await findBackendNodeIdsByRoleName(
    cdp,
    sessionId,
    locator.role,
    locator.name,
  );
  const nth = locator.nth as number | "last" | undefined;
  if (nth === undefined) {
    return backendNodeIds;
  }
  const nthIndex = nth === "last" ? backendNodeIds.length - 1 : nth;
  const backendNodeId = backendNodeIds[nthIndex];
  return backendNodeId === undefined ? [] : [backendNodeId];
}

function exceptionText(result: any) {
  const d = result?.exceptionDetails;
  const raw = d?.exception?.description || d?.text || "evaluation error";
  // `description` is the page-side stack: message plus frames of the expression
  // ego-browser injected. Those `<anonymous>:3:36` lines are not in the agent's
  // script and only add noise, and the "Error: " prefix duplicates ours.
  return String(raw)
    .split("\n")[0]
    .replace(/^Error:\s*/, "");
}

/**
 * One wording for one condition: nothing on the page matches this selector.
 * Five different phrasings for it used to make the agent treat the same
 * outcome as five different problems.
 */
export function noMatchMessage(
  selector: unknown,
  waitedMs?: number,
  detail?: string,
) {
  const waited = waitedMs === undefined ? "" : ` after waiting ${waitedMs}ms`;
  const recipe =
    waitedMs === undefined
      ? ""
      : ". If it appears later, wait for it explicitly: await page.waitForSelector(selector, { timeout })" +
        " or page.locator(selector).waitFor({ timeout }), or raise the default with page.setDefaultTimeout(ms).";
  return `No element matches ${describeSelector(selector)}${waited}${detail ? ` (${detail})` : ""}${recipe}`;
}

/** "matched N elements" is only actionable with the way to narrow it down. */
function withStrictModeRecipe(message: string): string {
  return `${message}. Narrow it: page.locator(selector).first() / .nth(index) / .last(), .filter({ hasText }), or a more specific locator.`;
}

function matchCountKind(message: string): "transient" | "permanent" {
  const m = /matched (\d+)/.exec(message);
  const n = m ? Number(m[1]) : 0;
  return n > 1 ? "permanent" : "transient";
}

function selectorResolutionError(selector, result) {
  const message = exceptionText(result);
  if (/\bmatched \d+ elements\b/.test(message)) {
    const kind = matchCountKind(message);
    return new ElementResolutionError(
      kind === "permanent" ? withStrictModeRecipe(message) : message,
      kind,
    );
  }
  return new ElementResolutionError(
    invalidSelectorMessage(selector, message),
    "permanent",
  );
}

/**
 * The browser's own text for a bad selector is a stack-shaped SyntaxError that
 * tells the agent nothing it can act on. Say which of the two mistakes it is.
 */
export function invalidSelectorMessage(selector: unknown, detail: string) {
  const raw = String(selector).trim();
  if (raw.startsWith("@")) return invalidRefMessage(raw);
  if (
    /failed to execute 'query/i.test(detail) ||
    /is not a valid selector/i.test(detail)
  ) {
    return `Invalid CSS selector ${JSON.stringify(raw)}: the browser cannot parse it (an unclosed bracket, quote or parenthesis?). Fix the syntax, or use a semantic locator such as page.getByRole(role, { name }).`;
  }
  return `Invalid selector ${JSON.stringify(raw)}: ${detail}`;
}

/**
 * Page-side point picker, shared by every click/hover/drag path.
 *
 * The union rectangle of an inline element that wraps across two lines has its
 * centre in the gap between the fragments, so a click there lands on the parent
 * and does nothing at all — no error, no navigation. Pick a fragment from
 * getClientRects() whose centre actually hits the element, and when nothing
 * does, say which element is in the way instead of dispatching into it.
 */
export const POINT_JS = `((el) => {
  if (!el) return { error: "not-found" };
  if (!el.isConnected) return { error: "detached" };
  const boxes = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  const rect = el.getBoundingClientRect();
  if (!boxes.length && rect.width > 0 && rect.height > 0) boxes.push(rect);
  if (!boxes.length) return { error: "no-box" };
  const describe = (n) => {
    if (!n) return "nothing";
    const tag = String(n.tagName || "node").toLowerCase();
    const id = n.id ? "#" + n.id : "";
    const cls =
      typeof n.className === "string" && n.className.trim()
        ? "." + n.className.trim().split(/\\s+/)[0]
        : "";
    return tag + id + cls;
  };
  let fallback = null;
  let blocker = null;
  for (const r of boxes) {
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    if (!fallback) fallback = { x: x, y: y };
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    const top = document.elementFromPoint(x, y);
    // No hit test result means the point is not in the viewport; there is no
    // evidence of interception, so keep it. An ancestor is not a hit: that is
    // exactly the wrapped-line gap this exists to avoid.
    if (!top) return { x: x, y: y };
    if (top === el || el.contains(top)) return { x: x, y: y };
    if (!blocker) blocker = describe(top);
  }
  return blocker
    ? { x: fallback.x, y: fallback.y, intercepted: blocker }
    : { x: fallback.x, y: fallback.y };
})`;

/** Turn the page-side point result into a point or an honest failure. */
function pointFromValue(value: any, label: string) {
  if (value?.error === "detached") {
    throw new ElementResolutionError(
      `${label} is no longer in the page (the DOM changed after it was located). Re-locate it and retry.`,
      "permanent",
    );
  }
  if (value?.error === "no-box" || value === null || value === undefined) {
    throw new ElementResolutionError(
      "Element has no box model (not rendered or zero-sized)",
      "transient",
    );
  }
  if (value?.error === "not-found") {
    throw new ElementResolutionError(noMatchMessage(label), "transient");
  }
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    throw new ElementResolutionError(noMatchMessage(label), "transient");
  }
  if (value.intercepted) {
    throw new ElementResolutionError(
      `${label} is not clickable at (${Math.round(value.x)}, ${Math.round(value.y)}): <${value.intercepted}> intercepts pointer events there. ` +
        `Dismiss the overlay, scroll the element into view, or target the element that is actually on top.`,
      "transient",
    );
  }
  return { x: value.x, y: value.y };
}

/** Centre of a node addressed by backendNodeId, fragment-aware. */
async function pointForBackendNodeId(
  cdp,
  sessionId,
  backendNodeId,
  label: string,
) {
  const resolved = await send(
    cdp,
    "DOM.resolveNode",
    { backendNodeId, objectGroup: "ego-browser" },
    sessionId,
  );
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(
      "Element has no box model (not rendered or zero-sized)",
      "transient",
    );
  }
  const result = await send(
    cdp,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function(){ return ${POINT_JS}(this.nodeType===3?this.parentElement:(this.nodeType===9?this.documentElement:this)) }`,
      returnByValue: true,
      objectGroup: "ego-browser",
    },
    sessionId,
  );
  return pointFromValue(result?.result?.value, label);
}

/**
 * Refuse a ref from a page that is gone.
 *
 * backendNodeIds are per-document and Chrome reuses the numbers, so after a
 * navigation an old `@N` could resolve to an unrelated element of the new page
 * and read back a plausible, wrong value. The snapshot records a token in the
 * document; if the page no longer carries it, every read through that ref
 * fails with the re-snapshot recipe instead.
 */
async function assertRefDocument(cdp, sessionId, refMap, refId) {
  const expected = refMap?.documentToken;
  if (!expected) return;
  let actual: unknown;
  try {
    const result = await send(
      cdp,
      "Runtime.evaluate",
      { expression: DOCUMENT_TOKEN_JS, returnByValue: true },
      sessionId,
    );
    actual = result?.result?.value;
  } catch {
    return; // cannot tell; let the normal resolution decide
  }
  if (actual !== expected) {
    throw new ElementResolutionError(
      refFromOtherDocumentMessage(refId),
      "permanent",
    );
  }
}

export async function resolveElementCenter(
  cdp,
  sessionId,
  refMap,
  selectorOrRef,
  iframeSessions = new Map(),
) {
  const refId = parseRef(selectorOrRef);
  if (refId) {
    const entry = refMap.get(refId);
    if (!entry) {
      throw new ElementResolutionError(
        `Unknown ref: @${refId} is not in the current snapshot. ` +
          `Run page.snapshot() and use a ref it prints (waiting will not create it).`,
        "permanent",
      );
    }
    const effectiveSessionId = resolveFrameSession(
      entry.frameId,
      sessionId,
      iframeSessions,
    );
    await assertRefDocument(cdp, effectiveSessionId, refMap, refId);
    if (entry.backendNodeId !== undefined && entry.backendNodeId !== null) {
      try {
        const point = await pointForBackendNodeId(
          cdp,
          effectiveSessionId,
          entry.backendNodeId,
          `Ref @${refId}`,
        );
        return { ...point, sessionId: effectiveSessionId };
      } catch (error) {
        if (error instanceof ElementResolutionError) {
          // The node resolved but has no usable box model (not rendered yet).
          // Propagate the retryable state instead of falling back to role/name,
          // which could silently target a different node with the same label.
          throw error;
        }
        // The backend node can become stale after DOM updates; fall back to role/name lookup below.
      }
    }
    const backendNodeId = await findBackendNodeIdByRoleName(
      cdp,
      sessionId,
      entry.role,
      entry.name,
      entry.nth,
      entry.frameId,
      iframeSessions,
    );
    const point = await pointForBackendNodeId(
      cdp,
      effectiveSessionId,
      backendNodeId,
      `Ref @${refId}`,
    );
    return { ...point, sessionId: effectiveSessionId };
  }

  const locator = parseLocator(selectorOrRef);
  if (locator) {
    return resolveLocatorCenter(cdp, sessionId, locator);
  }

  const result = await send(
    cdp,
    "Runtime.evaluate",
    {
      expression: buildSelectorCenterJs(selectorOrRef),
      returnByValue: true,
      awaitPromise: false,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw selectorResolutionError(selectorOrRef, result);
  }
  return {
    ...pointFromValue(result.result?.value, describeSelector(selectorOrRef)),
    sessionId,
  };
}

/**
 * Snapshot rows include text and document nodes (`StaticText`, `RootWebArea`),
 * so a `@N` can resolve to something that is not an element and every read
 * helper then fails with "JavaScript evaluation failed". Promote those to the
 * element the row is really about: a text node's parent, a document's <html>.
 * Elements cost nothing extra — the class name says when the hop is needed.
 */
async function elementObjectId(cdp, sessionId, resolved, label: string) {
  const objectId = resolved?.object?.objectId;
  if (!objectId) return objectId;
  // One hop does both jobs: refuse a node the page has thrown away, and hand
  // back the element the snapshot row is about. DOM.resolveNode happily
  // resolves a detached node, so without this a read after a DOM change
  // returns the pre-change value and the agent confirms a success that never
  // happened.
  const live = await send(
    cdp,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration:
        "function(){if(!this.isConnected)throw new Error('ego-browser:detached');" +
        "return this.nodeType===3?this.parentElement:(this.nodeType===9?this.documentElement:this)}",
      objectGroup: "ego-browser",
    },
    sessionId,
  );
  if (live?.exceptionDetails) {
    // A ref points at one captured node, so it goes stale; a semantic locator
    // re-matches every time, so its element was removed mid-operation.
    throw new ElementResolutionError(
      label.startsWith("Ref @")
        ? `${label} is stale: that element is no longer in the page (the DOM changed after the snapshot). ` +
            `Re-run page.snapshot() and use a ref from the new snapshot, or use a semantic locator such as page.getByRole(...).`
        : `${label} matched an element that the page removed before the operation finished. ` +
            `The page re-rendered; re-read it (page.snapshot() or another read) and repeat the action.`,
      "permanent",
    );
  }
  return live?.result?.objectId || objectId;
}

export async function resolveElementObjectId(
  cdp,
  sessionId,
  refMap,
  selectorOrRef,
  iframeSessions = new Map(),
) {
  const refId = parseRef(selectorOrRef);
  if (refId) {
    const entry = refMap.get(refId);
    if (!entry) {
      throw new ElementResolutionError(
        `Unknown ref: @${refId} is not in the current snapshot. ` +
          `Run page.snapshot() and use a ref it prints (waiting will not create it).`,
        "permanent",
      );
    }
    const effectiveSessionId = resolveFrameSession(
      entry.frameId,
      sessionId,
      iframeSessions,
    );
    await assertRefDocument(cdp, effectiveSessionId, refMap, refId);
    if (entry.backendNodeId !== undefined && entry.backendNodeId !== null) {
      try {
        const result = await send(
          cdp,
          "DOM.resolveNode",
          {
            backendNodeId: entry.backendNodeId,
            objectGroup: "ego-browser",
          },
          effectiveSessionId,
        );
        const objectId = await elementObjectId(
          cdp,
          effectiveSessionId,
          result,
          `Ref @${refId}`,
        );
        if (objectId) {
          return { objectId, sessionId: effectiveSessionId };
        }
      } catch (error) {
        // A stale ref is an honest failure: falling back to role/name here
        // would silently pick a different node wearing the same label.
        if (error instanceof ElementResolutionError) throw error;
        // The backend node id is simply unknown to CDP now; try role/name.
      }
    }
    const backendNodeId = await findBackendNodeIdByRoleName(
      cdp,
      sessionId,
      entry.role,
      entry.name,
      entry.nth,
      entry.frameId,
      iframeSessions,
    );
    const result = await send(
      cdp,
      "DOM.resolveNode",
      { backendNodeId, objectGroup: "ego-browser" },
      effectiveSessionId,
    );
    const objectId = await elementObjectId(
      cdp,
      effectiveSessionId,
      result,
      `Ref @${refId}`,
    );
    if (!objectId) {
      throw new ElementResolutionError(
        `No objectId for ref ${refId}`,
        "permanent",
      );
    }
    return { objectId, sessionId: effectiveSessionId };
  }

  const locator = parseLocator(selectorOrRef);
  if (locator) {
    return await resolveLocatorObjectId(cdp, sessionId, locator);
  }

  const result = await send(
    cdp,
    "Runtime.evaluate",
    {
      expression: buildFindElementJs(selectorOrRef),
      returnByValue: false,
      awaitPromise: false,
      objectGroup: "ego-browser",
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw selectorResolutionError(selectorOrRef, result);
  }
  const objectId = result.result?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(
      noMatchMessage(selectorOrRef),
      "transient",
    );
  }
  return { objectId, sessionId };
}

function resolveFrameSession(frameId, sessionId, iframeSessions) {
  if (!frameId) {
    return sessionId;
  }
  if (iframeSessions instanceof Map) {
    return iframeSessions.get(frameId) || sessionId;
  }
  return iframeSessions?.[frameId] || sessionId;
}

async function resolveLocatorCenter(cdp, sessionId, locator) {
  if (locator.kind === "role") {
    const backendNodeId =
      locator.nth === undefined
        ? await findUniqueBackendNodeIdByRoleName(
            cdp,
            sessionId,
            locator.role,
            locator.name,
          )
        : await findBackendNodeIdByRoleName(
            cdp,
            sessionId,
            locator.role,
            locator.name,
            locator.nth,
          );
    const point = await pointForBackendNodeId(
      cdp,
      sessionId,
      backendNodeId,
      describeSelector(locator.raw),
    );
    return { ...point, sessionId };
  }
  const result = await send(
    cdp,
    "Runtime.evaluate",
    {
      expression: buildLocatorCenterJs(locator),
      returnByValue: true,
      awaitPromise: false,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new ElementResolutionError(
      invalidSelectorMessage(locator.raw, exceptionText(result)),
      "permanent",
    );
  }
  const value = result.result?.value;
  // "matched N elements" comes from the locator itself, not the point picker.
  if (typeof value?.error === "string" && /matched/.test(value.error)) {
    throw new ElementResolutionError(
      matchCountKind(value.error) === "permanent"
        ? withStrictModeRecipe(value.error)
        : value.error,
      matchCountKind(value.error),
    );
  }
  return {
    ...pointFromValue(value, describeSelector(locator.raw)),
    sessionId,
  };
}

async function resolveLocatorObjectId(cdp, sessionId, locator) {
  if (locator.kind === "role") {
    const backendNodeId =
      locator.nth === undefined
        ? await findUniqueBackendNodeIdByRoleName(
            cdp,
            sessionId,
            locator.role,
            locator.name,
          )
        : await findBackendNodeIdByRoleName(
            cdp,
            sessionId,
            locator.role,
            locator.name,
            locator.nth,
          );
    const result = await send(
      cdp,
      "DOM.resolveNode",
      { backendNodeId, objectGroup: "ego-browser" },
      sessionId,
    );
    // Same promotion + liveness hop the ref path uses: a role locator can name
    // a StaticText or the document, and reads must land on a real element.
    const objectId = await elementObjectId(
      cdp,
      sessionId,
      result,
      describeSelector(locator.raw),
    );
    if (!objectId) {
      throw new ElementResolutionError(
        `No objectId for locator ${locator.raw}`,
        "permanent",
      );
    }
    return { objectId, sessionId };
  }
  const count = await locatorCount(cdp, sessionId, locator);
  if (count === 0) {
    throw new ElementResolutionError(noMatchMessage(locator.raw), "transient");
  }
  if (typeof locator.nth === "number" && count <= locator.nth) {
    throw new ElementResolutionError(noMatchMessage(locator.raw), "transient");
  }
  if (locator.nth === undefined && count > 1) {
    throw new ElementResolutionError(
      `Locator ${locator.raw} matched ${count} elements`,
      "permanent",
    );
  }
  const result = await send(
    cdp,
    "Runtime.evaluate",
    {
      expression: buildLocatorFindJs(locator),
      returnByValue: false,
      awaitPromise: false,
      objectGroup: "ego-browser",
    },
    sessionId,
  );
  const objectId = result.result?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(noMatchMessage(locator.raw), "transient");
  }
  return { objectId, sessionId };
}

async function locatorCount(cdp, sessionId, locator) {
  const result = await send(
    cdp,
    "Runtime.evaluate",
    {
      expression: buildLocatorCountJs(locator),
      returnByValue: true,
      awaitPromise: false,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new ElementResolutionError(
      invalidSelectorMessage(locator.raw, exceptionText(result)),
      "permanent",
    );
  }
  return Number(result.result?.value || 0);
}

async function findBackendNodeIdByRoleName(
  cdp,
  sessionId,
  role,
  name,
  nth = undefined,
  frameId = undefined,
  iframeSessions = new Map(),
) {
  const matches = await findBackendNodeIdsByRoleName(
    cdp,
    sessionId,
    role,
    name,
    frameId,
    iframeSessions,
  );
  const nthIndex = nth === "last" ? matches.length - 1 : (nth ?? 0);
  const match = matches[nthIndex];
  if (match !== undefined) {
    return match;
  }
  throw new ElementResolutionError(
    noMatchMessage(roleLocatorLabel(role, name)),
    "transient",
  );
}

async function findBackendNodeIdsByRoleName(
  cdp,
  sessionId,
  role,
  name,
  frameId = undefined,
  iframeSessions = new Map(),
): Promise<number[]> {
  const [params, effectiveSessionId] = resolveAxSession(
    frameId,
    sessionId,
    iframeSessions,
  );
  const nodes = await axNodesForRole(
    cdp,
    effectiveSessionId,
    role,
    name,
    params,
  );
  const matches = [];
  for (const node of nodes) {
    if (node.ignored) {
      continue;
    }
    if (extractAxString(node.role) !== role) {
      continue;
    }
    if (
      name !== undefined &&
      !axNameMatches(extractAxString(node.name), name)
    ) {
      continue;
    }
    const backendNodeId = node.backendDOMNodeId;
    // An AX node with no DOM node behind it (a generated `[`, a ::marker) is
    // not addressable. It is not this query's failure — skip it, so a stray
    // node cannot abort a lookup that has real matches.
    if (backendNodeId === undefined || backendNodeId === null) {
      continue;
    }
    matches.push(backendNodeId);
  }
  return matches;
}

/**
 * Candidate AX nodes for a role/name query.
 *
 * `Accessibility.getFullAXTree` ships every node of the page (6.6k on a real
 * article, ~800ms per query). `queryAXTree` makes Chrome do the matching and
 * returns only the candidates, which is the same answer in a couple of ms.
 * The full tree stays as the fallback: iframe-scoped queries and any browser
 * that refuses the query keep working.
 */
async function axNodesForRole(cdp, sessionId, role, name, fullTreeParams: any) {
  if (!fullTreeParams?.frameId) {
    try {
      const doc = await send(cdp, "DOM.getDocument", { depth: 0 }, sessionId);
      const rootBackendNodeId = doc?.root?.backendNodeId;
      if (rootBackendNodeId) {
        const query: any = { backendNodeId: rootBackendNodeId, role };
        // accessibleName is an exact match in CDP, which is exactly what a
        // plain string name means here; matcher objects stay in Node.
        if (typeof name === "string") query.accessibleName = name;
        const result = await send(
          cdp,
          "Accessibility.queryAXTree",
          query,
          sessionId,
        );
        if (Array.isArray(result?.nodes)) return result.nodes;
      }
    } catch {
      // Fall through to the full tree.
    }
  }
  const result = await send(
    cdp,
    "Accessibility.getFullAXTree",
    fullTreeParams,
    sessionId,
  );
  return result?.nodes || [];
}

/** `role:link` when no name was asked for, `role:link[name="Home"]` when one was. */
function roleLocatorLabel(role, name) {
  return name === undefined || name === null
    ? `role:${role}`
    : `role:${role}[name=${JSON.stringify(name)}]`;
}

async function findUniqueBackendNodeIdByRoleName(cdp, sessionId, role, name) {
  const matches = await findBackendNodeIdsByRoleName(
    cdp,
    sessionId,
    role,
    name,
  );
  if (matches.length === 0) {
    throw new ElementResolutionError(
      noMatchMessage(roleLocatorLabel(role, name)),
      "transient",
    );
  }
  if (matches.length > 1) {
    throw new ElementResolutionError(
      withStrictModeRecipe(
        `Locator ${roleLocatorLabel(role, name)} matched ${matches.length} elements`,
      ),
      "permanent",
    );
  }
  return matches[0];
}

function resolveAxSession(frameId, sessionId, iframeSessions) {
  if (!frameId) {
    return [{}, sessionId];
  }
  const iframeSession =
    iframeSessions instanceof Map
      ? iframeSessions.get(frameId)
      : iframeSessions?.[frameId];
  if (iframeSession) {
    return [{}, iframeSession];
  }
  return [{ frameId }, sessionId];
}

function buildFindElementJs(selector) {
  const matchError = JSON.stringify(`Locator ${String(selector)} matched `);
  return `(() => {
    const elements = ${queryAllExpression(selector)};
    if (elements.length > 1) throw new Error(${matchError} + elements.length + ' elements');
    return elements[0] || null;
  })()`;
}

function buildLocatorFindJs(locator) {
  if (locator.kind === "query") {
    return `(() => {
      const elements = ${queryAllExpression(locator.selector)};
      return elements[${locator.nth === "last" ? "elements.length - 1" : JSON.stringify(locator.nth ?? 0)}] || null;
    })()`;
  }
  if (locator.kind === "css") {
    const selector = `loc=css:${locator.selector}`;
    if (locator.nth !== undefined) {
      return `(() => {
        const elements = ${queryAllExpression(selector)};
        return elements[${locator.nth === "last" ? "elements.length - 1" : JSON.stringify(locator.nth)}] || null;
      })()`;
    }
    return `(() => ${queryAllExpression(selector)}[0] || null)()`;
  }
  if (locator.kind === "xpath") {
    return `(() => {
      const snapshot = document.evaluate(${JSON.stringify(locator.xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return snapshot.snapshotItem(${locator.nth === "last" ? "snapshot.snapshotLength - 1" : JSON.stringify(locator.nth ?? 0)});
    })()`;
  }
  if (
    locator.kind === "text" ||
    locator.kind === "label" ||
    locator.kind === "placeholder" ||
    locator.kind === "alt" ||
    locator.kind === "title" ||
    locator.kind === "testid"
  ) {
    return `(() => {
      const elements = ${buildLocatorAllJs(locator)};
      return elements[${locator.nth === "last" ? "elements.length - 1" : JSON.stringify(locator.nth ?? 0)}] || null;
    })()`;
  }
  return locator.nth === "last"
    ? `(() => ${hrefElementsJs(locator.href)}.at(-1) || null)()`
    : `(() => ${hrefElementsJs(locator.href)}[${JSON.stringify(locator.nth ?? 0)}] || null)()`;
}

function buildLocatorCountJs(locator) {
  if (locator.kind === "query") {
    return `(() => ${queryAllExpression(locator.selector)}.length)()`;
  }
  if (locator.kind === "css") {
    return `(() => ${queryAllExpression(`loc=css:${locator.selector}`)}.length)()`;
  }
  if (locator.kind === "xpath") {
    return `(() => document.evaluate(${JSON.stringify(locator.xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength)()`;
  }
  if (
    locator.kind === "text" ||
    locator.kind === "label" ||
    locator.kind === "placeholder" ||
    locator.kind === "alt" ||
    locator.kind === "title" ||
    locator.kind === "testid"
  ) {
    return `(() => ${buildLocatorAllJs(locator)}.length)()`;
  }
  return `(() => ${hrefElementsJs(locator.href)}.length)()`;
}

function buildLocatorCenterJs(locator) {
  if (locator.nth !== undefined) {
    return `(() => {
            const el = ${buildLocatorFindJs(locator)};
            if (!el) return { error: ${JSON.stringify(noMatchMessage(locator.raw))} };
            return ${POINT_JS}(el);
        })()`;
  }
  return `(() => {
            const count = ${buildLocatorCountJs(locator)};
            if (count !== 1) return { error: ${JSON.stringify(`Locator ${locator.raw} matched`)} + ' ' + count + ' elements' };
            const el = ${buildLocatorFindJs(locator)};
            if (!el) return null;
            return ${POINT_JS}(el);
        })()`;
}

function hrefElementsJs(href) {
  return `Array.from(document.querySelectorAll('a[href]')).filter((el) => {
            try {
              const u = new URL(el.href, location.href);
              const path = u.pathname + u.search + u.hash;
              return path === ${JSON.stringify(href)} || u.href === ${JSON.stringify(href)};
            } catch {
              return false;
            }
          })`;
}

function buildLocatorAllJs(locator) {
  if (locator.kind === "text") {
    return textElementsJs(locator);
  }
  if (locator.kind === "label") {
    return labelElementsJs(locator);
  }
  if (locator.kind === "placeholder") {
    return attributeElementsJs(
      "input[placeholder], textarea[placeholder]",
      "placeholder",
      locator,
    );
  }
  if (locator.kind === "alt") {
    return attributeElementsJs("img[alt], input[alt]", "alt", locator);
  }
  if (locator.kind === "title") {
    return attributeElementsJs("[title]", "title", locator);
  }
  if (locator.kind === "testid") {
    return attributeElementsJs("[data-testid]", "data-testid", locator);
  }
  throw new Error(`unsupported locator kind: ${locator.kind}`);
}

function textElementsJs(locator) {
  const match = textMatchJs(
    "el.innerText || el.textContent",
    locator.text,
    locator.exact,
  );
  const childMatch = textMatchJs(
    "child.innerText || child.textContent",
    locator.text,
    locator.exact,
  );
  return `Array.from(document.querySelectorAll('body *')).filter((el) => {
            if (!(${match})) return false;
            return !Array.from(el.children || []).some((child) => ${childMatch});
          })`;
}

function labelElementsJs(locator) {
  const labelMatch = textMatchJs(
    "label.innerText || label.textContent",
    locator.text,
    locator.exact,
  );
  const ariaMatch = textMatchJs(
    "el.getAttribute('aria-label')",
    locator.text,
    locator.exact,
  );
  const labelledByMatch = textMatchJs(
    "labelledBy",
    locator.text,
    locator.exact,
  );
  return `(() => {
            const controls = [];
            for (const label of document.querySelectorAll('label')) {
              if (!(${labelMatch})) continue;
              const control = label.control || (label.getAttribute('for') ? document.getElementById(label.getAttribute('for')) : null);
              if (control) controls.push(control);
            }
            for (const el of document.querySelectorAll('input, textarea, select, button, [role]')) {
              if (el.getAttribute('aria-label') && ${ariaMatch}) controls.push(el);
              const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
              if (ids.length) {
                const labelledBy = ids.map((id) => document.getElementById(id)?.textContent || '').join(' ');
                if (${labelledByMatch}) controls.push(el);
              }
            }
            return Array.from(new Set(controls));
          })()`;
}

function attributeElementsJs(selector, attribute, locator) {
  const match = textMatchJs(
    `el.getAttribute(${JSON.stringify(attribute)})`,
    locator.text,
    locator.exact,
  );
  return `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((el) => ${match})`;
}

function textMatchJs(valueExpression, text, exact) {
  const needle = JSON.stringify(String(text).replace(/\s+/g, " ").trim());
  const normalized = `String(${valueExpression} || '').replace(/\\s+/g, ' ').trim()`;
  return exact
    ? `${normalized} === ${needle}`
    : `${normalized}.includes(${needle})`;
}

function buildSelectorCenterJs(selector) {
  const findExpr = buildFindElementJs(selector);
  return `(() => {
            const el = ${findExpr};
            if (!el) return null;
            return ${POINT_JS}(el);
        })()`;
}

function parseLocator(input) {
  let value = String(input || "").trim();
  let nth: number | undefined;
  // `role:link[name="Jump up"] >> nth=12` — the form a snapshot row uses when
  // role+name alone matches several elements.
  const chainedNth = / >> nth=(\d+)$/.exec(value);
  if (chainedNth) {
    nth = Number(chainedNth[1]);
    value = value.slice(0, chainedNth.index);
  }
  const nthMatch = /^internal:nth=(\d+);([\s\S]+)$/.exec(value);
  if (nthMatch) {
    nth = Number(nthMatch[1]);
    value = nthMatch[2];
  }
  const lastMatch = /^internal:last;([\s\S]+)$/.exec(value);
  if (lastMatch) {
    nth = "last" as any;
    value = lastMatch[1];
  }
  if (
    value.startsWith("internal:scope:") ||
    value.startsWith("internal:filter:")
  ) {
    return { kind: "query", selector: value, raw: value, nth };
  }
  if (value.startsWith("loc=")) {
    value = value.slice(4);
  }
  if (value.startsWith("css:")) {
    const selector = value.slice(4);
    return selector ? { kind: "css", selector, raw: value, nth } : null;
  }
  if (value.startsWith("href:")) {
    const href = value.slice(5);
    return href ? { kind: "href", href, raw: value, nth } : null;
  }
  if (value.startsWith("text:")) {
    return {
      kind: "text",
      ...parseTextLocator(value.slice(5)),
      raw: value,
      nth,
    };
  }
  if (value.startsWith("text=")) {
    return {
      kind: "text",
      text: value.slice(5),
      exact: false,
      raw: value,
      nth,
    };
  }
  if (value.startsWith("label:")) {
    return {
      kind: "label",
      ...parseTextLocator(value.slice(6)),
      raw: value,
      nth,
    };
  }
  if (value.startsWith("placeholder:")) {
    return {
      kind: "placeholder",
      ...parseTextLocator(value.slice(12)),
      raw: value,
      nth,
    };
  }
  if (value.startsWith("alt:")) {
    return {
      kind: "alt",
      ...parseTextLocator(value.slice(4)),
      raw: value,
      nth,
    };
  }
  if (value.startsWith("title:")) {
    return {
      kind: "title",
      ...parseTextLocator(value.slice(6)),
      raw: value,
      nth,
    };
  }
  if (value.startsWith("testid:")) {
    return {
      kind: "testid",
      ...parseTextLocator(value.slice(7)),
      raw: value,
      nth,
    };
  }
  const roleMatch = /^role:([A-Za-z0-9_-]+)(?:\[name=(.+)\])?$/.exec(value);
  if (roleMatch) assertKnownRole(roleMatch[1]);
  if (roleMatch) {
    return {
      kind: "role",
      role: roleMatch[1],
      name:
        roleMatch[2] === undefined ? undefined : parseLocatorName(roleMatch[2]),
      raw: value,
      nth,
    };
  }
  if (nth !== undefined) {
    if (value.startsWith("xpath=")) {
      return { kind: "xpath", xpath: value.slice(6), raw: value, nth };
    }
    return { kind: "css", selector: value, raw: value, nth };
  }
  return null;
}

function parseLocatorName(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isTextMatcher(parsed)) {
        return parsed;
      }
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseTextLocator(raw) {
  if (raw.startsWith("exact:")) {
    return { text: parseLocatorName(raw.slice(6)), exact: true };
  }
  return { text: parseLocatorName(raw), exact: false };
}

function boxModelCenter(model: any = {}) {
  const content = model.content || [];
  if (content.length < 8) {
    // Returning a fake (0,0) here would silently click the viewport corner.
    // Treat a missing/degenerate box model as "element not ready" so callers
    // with retry semantics (waitForSelector, ref fallback) can poll.
    throw new ElementResolutionError(
      "Element has no box model (not rendered or zero-sized)",
      "transient",
    );
  }
  return {
    x: (content[0] + content[2] + content[4] + content[6]) / 4,
    y: (content[1] + content[3] + content[5] + content[7]) / 4,
  };
}

function extractAxString(value) {
  const raw = value?.value;
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  return "";
}

function axNameMatches(actual, expected) {
  if (isTextMatcher(expected)) {
    if (typeof expected.regex === "string") {
      try {
        return new RegExp(expected.regex, expected.flags || "").test(
          String(actual),
        );
      } catch {
        return false;
      }
    }
    const text = String(expected.text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const normalized = String(actual || "")
      .replace(/\s+/g, " ")
      .trim();
    return expected.exact ? normalized === text : normalized.includes(text);
  }
  return String(actual) === String(expected);
}

function isTextMatcher(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    (typeof value.regex === "string" || typeof value.text === "string"),
  );
}

function send(cdp, method, params: any = {}, sessionId = undefined) {
  return cdp.sendRaw(method, params, sessionId);
}
