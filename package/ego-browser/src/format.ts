import { getHelperDoc } from "./help-runtime.js";

type FunctionParamDoc = {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
};

type FunctionDoc = {
  signature: string;
  description: string;
  params?: FunctionParamDoc[];
  returns?: string;
  example?: string;
};

// Facades are thin aliases over the documented helpers. Keep only the names
// that differ from the underlying helper or need a more useful return type.
const FACADE_HELPERS: Record<string, string> = {
  "page.goto": "goto",
  "page.info": "pageInfo",
  "page.waitForTimeout": "waitForTimeout",
  "page.waitForLoadState": "waitForLoadState",
  "page.waitForSelector": "waitForSelector",
  "page.waitForFunction": "waitForFunction",
  "page.waitForURL": "waitForURL",
  "page.waitForRequest": "waitForRequest",
  "page.waitForResponse": "waitForResponse",
  "page.waitForEvent": "waitForEvent",
  "page.evaluate": "evaluate",
  "page.screenshot": "screenshot",
  "page.snapshot": "snapshot",
  "page.snapshotRaw": "snapshotRaw",
  "page.elementCenter": "elementCenter",
  "page.drainEvents": "drainEvents",
  "page.keyboard.press": "press",
  "page.keyboard.insertText": "insertText",
  "browser.listTabs": "listTabs",
  "browser.currentTab": "currentTab",
  "browser.switchTab": "switchTab",
  "browser.openOrReuseTab": "openOrReuseTab",
  "browser.closeTab": "closeTab",
  "browser.ensureRealTab": "ensureRealTab",
  "browser.iframeTarget": "iframeTarget",
  "taskSpaces.list": "listTaskSpaces",
  "taskSpaces.switch": "switchTaskSpace",
  "taskSpaces.new": "newTaskSpace",
  "taskSpaces.useOrCreate": "useOrCreateTaskSpace",
  "taskSpaces.claim": "claimTaskSpace",
  "taskSpaces.complete": "completeTaskSpace",
  "taskSpaces.handOff": "handOffTaskSpace",
  "taskSpaces.takeOver": "takeOverTaskSpace",
  "taskSpaces.waitForAgentControl": "waitForAgentControl",
  "site.skills": "siteSkills",
  "site.skillsForUrl": "siteSkillsForUrl",
  "site.runTool": "runSiteTool",
  "site.runBrowserTool": "runSiteBrowserTool",
  "site.learnContext": "learnContext",
  "fetch.server": "serverFetch",
  "fetch.browser": "browserFetch",
  cdp: "cdp",
  help: "help",
};

const FACADE_OVERRIDES: Record<string, Partial<FunctionDoc>> = {
  "page.setDefaultTimeout": {
    signature: "page.setDefaultTimeout(timeoutMs) => void",
    description: "Set the default timeout for page helper operations.",
    params: [{ name: "timeoutMs", type: "number", required: true }],
    returns: "void",
  },
  "page.reload": {
    signature: "page.reload(options?) => Promise<object>",
    description: "Reload the current page and wait for it to load.",
    params: [{ name: "options", type: "object" }],
    returns: "Promise<object>",
  },
  "page.url": {
    signature: "page.url() => Promise<string>",
    description: "Return the current page URL.",
    returns: "Promise<string>",
    example: "await page.url()",
  },
  "page.title": {
    signature: "page.title() => Promise<string>",
    description: "Return the current page title.",
    returns: "Promise<string>",
  },
  "page.locator": {
    signature: "page.locator(selector) => Locator",
    description:
      "Create a locator from a CSS, XPath, text, loc=..., or @ref selector.",
    returns: "Locator",
  },
  "page.getByRole": {
    signature: "page.getByRole(role, options?) => Locator",
    description: "Create a locator by accessibility role.",
    returns: "Locator",
  },
  "page.getByText": {
    signature: "page.getByText(text, options?) => Locator",
    description: "Create a locator by visible text.",
    returns: "Locator",
  },
  "page.getByLabel": {
    signature: "page.getByLabel(text, options?) => Locator",
    description: "Create a locator for a form control by label text.",
    returns: "Locator",
  },
  "page.getByPlaceholder": {
    signature: "page.getByPlaceholder(text, options?) => Locator",
    description: "Create a locator for an input by placeholder text.",
    returns: "Locator",
  },
  "page.getByAltText": {
    signature: "page.getByAltText(text, options?) => Locator",
    description: "Create a locator by image alt text.",
    returns: "Locator",
  },
  "page.getByTitle": {
    signature: "page.getByTitle(text, options?) => Locator",
    description: "Create a locator by title attribute.",
    returns: "Locator",
  },
  "page.waitForRequest": {
    signature:
      "page.waitForRequest(urlOrPredicate, options?) => Promise<Request>",
    returns: "Promise<Request>",
  },
  "page.waitForResponse": {
    signature:
      "page.waitForResponse(urlOrPredicate, options?) => Promise<Response>",
    returns: "Promise<Response>",
  },
  "page.waitForURL": {
    description:
      "Wait for the current page URL to match a string, glob, RegExp, or predicate receiving a URL object; it waits for load by default.",
  },
  "browser.openOrReuseTab": {
    signature: "browser.openOrReuseTab(url, options?) => Promise<object>",
    returns: "Promise<object>",
  },
  "site.runTool": {
    signature: "site.runTool(siteId, toolName, args?) => Promise<tool result>",
    returns: "Promise<tool result>",
    example:
      'const context = await site.learnContext();\nawait site.runTool("site-id", "tool-name", { key: "value" });',
  },
  cdp: {
    description:
      "Send a raw Chrome DevTools Protocol command. Browser.grantPermissions and Browser.setPermission are not exposed as helpers; use cdp(...) when needed.",
  },
  "page.mouse.click": {
    signature: "page.mouse.click(x, y, options?) => Promise<void>",
    description: "Click viewport coordinates.",
    returns: "Promise<void>",
  },
  "page.mouse.dblclick": {
    signature: "page.mouse.dblclick(x, y, options?) => Promise<void>",
    description: "Double-click viewport coordinates.",
    returns: "Promise<void>",
  },
  "page.mouse.move": {
    signature: "page.mouse.move(x, y) => Promise<void>",
    description: "Move the mouse to viewport coordinates.",
    returns: "Promise<void>",
  },
  "page.mouse.wheel": {
    signature: "page.mouse.wheel(deltaX, deltaY) => Promise<void>",
    description: "Scroll with a mouse wheel.",
    returns: "Promise<void>",
  },
  "page.mouse.drag": {
    signature: "page.mouse.drag(points, options?) => Promise<void>",
    description: "Drag between points or element selectors.",
    returns: "Promise<void>",
  },
};

function facadeDoc(key: string): FunctionDoc | undefined {
  const override = FACADE_OVERRIDES[key];
  const source = FACADE_HELPERS[key]
    ? getHelperDoc(FACADE_HELPERS[key])
    : undefined;
  if (!source && !override) return undefined;

  const params =
    override?.params ??
    source?.params?.map((param) => ({
      name: param.name,
      type: param.type || "unknown",
      ...(param.optional ? {} : { required: true }),
      ...(param.description ? { description: param.description } : {}),
    }));

  return {
    signature: override?.signature ?? source?.signature ?? `${key}(...)`,
    description:
      override?.description ?? source?.description ?? "Callable function.",
    ...(params?.length ? { params } : {}),
    ...((override?.returns ?? source?.returns)
      ? { returns: override?.returns ?? source?.returns ?? undefined }
      : {}),
    ...(override?.example ? { example: override.example } : {}),
  };
}

export function formatCliLogValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(toLoggable(value, [], new WeakSet<object>()), null, 2);
}

function toLoggable(
  value: unknown,
  path: string[],
  stack: WeakSet<object>,
): unknown {
  if (typeof value === "function") {
    return functionLogValue(value, path);
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value === undefined) {
    return "undefined";
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (stack.has(value)) {
    return "[Circular]";
  }

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        toLoggable(item, [...path, String(index)], stack),
      );
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = toLoggable(child, [...path, key], stack);
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

function functionLogValue(fn: Function, path: string[]) {
  const key = docKeyForPath(path);
  const doc = key ? facadeDoc(key) : undefined;
  const displayName = path.at(-1) || fn.name || "anonymous";
  if (!doc) {
    const callPath = path.length ? path.join(".") : displayName;
    return {
      kind: "function",
      name: fn.name || displayName,
      signature: `${callPath}(...)`,
      description:
        "Callable function. Inspect the surrounding facade or use help(name) when available.",
    };
  }

  return {
    kind: "function",
    name: displayName,
    signature: signatureForPath(doc.signature, path),
    description: doc.description,
    ...(doc.params ? { params: doc.params } : {}),
    ...(doc.returns ? { returns: doc.returns } : {}),
    ...(doc.example ? { example: exampleForPath(doc.example, path) } : {}),
  };
}

function docKeyForPath(path: string[]) {
  if (path[0] === "helpers") {
    return path.slice(1).join(".");
  }
  if (path[0] === "learnings") {
    return ["site", ...path.slice(1)].join(".");
  }
  return path.join(".");
}

function displayPathFor(path: string[]) {
  if (path[0] === "helpers") {
    return path.slice(1).join(".");
  }
  return path.join(".");
}

function signatureForPath(signature: string, path: string[]) {
  const openParen = signature.indexOf("(");
  const suffix = openParen >= 0 ? signature.slice(openParen) : "(...)";
  return `${displayPathFor(path)}${suffix}`.replace(" → ", " => ");
}

function exampleForPath(example: string, path: string[]) {
  if (path[0] === "learnings") {
    return example.replace(/\bsite\./g, "learnings.");
  }
  return example;
}
