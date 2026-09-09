import test from "node:test";
import assert from "node:assert/strict";

import {
  POINT_JS,
  invalidSelectorMessage,
  resolveElementCenter,
  resolveElementObjectId,
  ElementResolutionError,
} from "../dist/src/element-resolver.js";
import { RefMap } from "../dist/src/ref-map.js";

class FakeCDP {
  constructor(handler) {
    this.calls = [];
    this.handler = handler;
  }

  async sendRaw(method, params = {}, sessionId = undefined) {
    this.calls.push([method, params, sessionId]);
    return this.handler(method, params, sessionId);
  }
}

/**
 * The point picker runs in the page now (fragment-aware, hit-tested), so a
 * centre is DOM.resolveNode + Runtime.callFunctionOn instead of DOM.getBoxModel.
 */
function pointReply(method, point) {
  if (method === "DOM.resolveNode") return { object: { objectId: "node-1" } };
  if (method === "Runtime.callFunctionOn") return { result: { value: point } };
  return null;
}

const AX_TREE = {
  nodes: [
    { role: { value: "button" }, name: { value: "ok" }, backendDOMNodeId: 100 },
  ],
};

function internalSelector(kind, data) {
  return `internal:${kind}:${encodeURIComponent(JSON.stringify(data))}`;
}

test("resolveElementCenter computes the center from a valid box model", async () => {
  const refMap = new RefMap();
  refMap.add("5", 100, "button", "ok");
  const cdp = new FakeCDP(async (method) => {
    return pointReply(method, { x: 20, y: 40 }) ?? {};
  });
  const point = await resolveElementCenter(cdp, undefined, refMap, "@5");
  assert.equal(point.x, 20);
  assert.equal(point.y, 40);
});

test("degenerate box model throws transient instead of returning (0,0)", async () => {
  // Regression: boxModelCenter used to return {x:0,y:0} for a missing content
  // quad, which made callers click the top-left viewport corner.
  const refMap = new RefMap();
  refMap.add("5", 100, "button", "ok");
  const cdp = new FakeCDP(async (method) => {
    if (method === "Accessibility.getFullAXTree") {
      return AX_TREE;
    }
    return pointReply(method, { error: "no-box" }) ?? {};
  });
  await assert.rejects(
    () => resolveElementCenter(cdp, undefined, refMap, "@5"),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "transient");
      assert.match(error.message, /no box model/);
      return true;
    },
  );
  assert.ok(
    !cdp.calls.some(([method]) => method === "Accessibility.getFullAXTree"),
    "must not fall back to role/name lookup — it could match a different node with the same label",
  );
});

test("stale backend node still falls back to role/name lookup", async () => {
  const refMap = new RefMap();
  refMap.add("5", 100, "button", "ok");
  let resolveCalls = 0;
  const cdp = new FakeCDP(async (method) => {
    if (method === "DOM.resolveNode") {
      resolveCalls += 1;
      if (resolveCalls === 1) {
        throw new Error("No node with given id found");
      }
      return { object: { objectId: "node-1" } };
    }
    if (method === "Accessibility.getFullAXTree") {
      return AX_TREE;
    }
    return pointReply(method, { x: 5, y: 5 }) ?? {};
  });
  const point = await resolveElementCenter(cdp, undefined, refMap, "@5");
  assert.equal(point.x, 5);
  assert.equal(point.y, 5);
  assert.ok(
    cdp.calls.some(([method]) => method === "Accessibility.getFullAXTree"),
    "a stale node must trigger the role/name fallback",
  );
});

test("role locator with degenerate box model throws transient", async () => {
  const cdp = new FakeCDP(async (method) => {
    if (method === "Accessibility.getFullAXTree") {
      return AX_TREE;
    }
    if (method === "DOM.getBoxModel") {
      return { model: {} };
    }
    return {};
  });
  await assert.rejects(
    () =>
      resolveElementCenter(
        cdp,
        undefined,
        new RefMap(),
        'loc=role:button[name="ok"]',
      ),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "transient");
      return true;
    },
  );
});

test("css locator matched 0 elements is transient", async () => {
  const cdp = new FakeCDP(async (method) => {
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: { error: "Locator css:.missing matched 0 elements" },
        },
      };
    }
    return {};
  });
  await assert.rejects(
    () =>
      resolveElementCenter(cdp, undefined, new RefMap(), "loc=css:.missing"),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "transient");
      return true;
    },
  );
});

test("css locator matched multiple elements is permanent", async () => {
  const cdp = new FakeCDP(async (method) => {
    if (method === "Runtime.evaluate") {
      return {
        result: {
          value: { error: "Locator css:.duplicate matched 2 elements" },
        },
      };
    }
    return {};
  });
  await assert.rejects(
    () =>
      resolveElementCenter(cdp, undefined, new RefMap(), "loc=css:.duplicate"),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "permanent");
      return true;
    },
  );
});

test("raw CSS selector matched multiple elements is permanent", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /querySelectorAll\("\.duplicate"\)/);
      assert.match(params.expression, /elements\.length > 1/);
      return {
        exceptionDetails: {
          exception: {
            description: "Error: Locator .duplicate matched 2 elements",
          },
        },
      };
    }
    return {};
  });
  await assert.rejects(
    () => resolveElementCenter(cdp, undefined, new RefMap(), ".duplicate"),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "permanent");
      assert.match(error.message, /matched 2 elements/);
      return true;
    },
  );
});

test("raw XPath selector matched multiple elements is permanent for reads", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(
        params.expression,
        /XPathResult\.ORDERED_NODE_SNAPSHOT_TYPE/,
      );
      assert.match(params.expression, /elements\.length > 1/);
      return {
        exceptionDetails: {
          exception: {
            description: "Error: Locator xpath=\/\/button matched 2 elements",
          },
        },
      };
    }
    return {};
  });
  await assert.rejects(
    () =>
      resolveElementObjectId(cdp, undefined, new RefMap(), "xpath=//button"),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "permanent");
      assert.match(error.message, /matched 2 elements/);
      return true;
    },
  );
});

test("raw CSS selector matched zero elements remains transient", async () => {
  const cdp = new FakeCDP(async (method) => {
    if (method === "Runtime.evaluate") {
      return { result: { value: null } };
    }
    return {};
  });
  await assert.rejects(
    () => resolveElementCenter(cdp, undefined, new RefMap(), ".missing"),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "transient");
      return true;
    },
  );
});

test("raw Playwright has-text selector resolves through filtered CSS candidates", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /querySelectorAll\("button"\)/);
      assert.match(params.expression, /includes\("Skip to Checkout"\)/);
      return { result: { value: { x: 10, y: 20 } } };
    }
    return {};
  });
  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    'button:has-text("Skip to Checkout")',
  );
  assert.deepEqual(point, { x: 10, y: 20, sessionId: undefined });
});

test("role locator matches numeric AX names", async () => {
  const cdp = new FakeCDP(async (method) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            role: { value: "button" },
            name: { value: 7 },
            backendDOMNodeId: 100,
          },
        ],
      };
    }
    return pointReply(method, { x: 20, y: 40 }) ?? {};
  });
  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    "loc=role:button[name=7]",
  );
  assert.deepEqual(point, { x: 20, y: 40, sessionId: undefined });
});

test("role locator matches boolean AX names", async () => {
  const cdp = new FakeCDP(async (method) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            role: { value: "button" },
            name: { value: true },
            backendDOMNodeId: 100,
          },
        ],
      };
    }
    return pointReply(method, { x: 20, y: 40 }) ?? {};
  });
  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    "loc=role:button[name=true]",
  );
  assert.deepEqual(point, { x: 20, y: 40, sessionId: undefined });
});

test("role locator matches regex AX names", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            role: { value: "button" },
            name: { value: "Skip to Checkout" },
            backendDOMNodeId: 100,
          },
        ],
      };
    }
    if (method === "DOM.resolveNode") assert.equal(params.backendNodeId, 100);
    return pointReply(method, { x: 20, y: 40 }) ?? {};
  });
  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    `loc=role:button[name=${JSON.stringify({ regex: "checkout", flags: "i" })}]`,
  );
  assert.deepEqual(point, { x: 20, y: 40, sessionId: undefined });
});

test("internal nth role locator resolves the requested AX match", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            role: { value: "button" },
            name: { value: "Download" },
            backendDOMNodeId: 100,
          },
          {
            role: { value: "button" },
            name: { value: "Download" },
            backendDOMNodeId: 200,
          },
        ],
      };
    }
    if (method === "DOM.resolveNode") assert.equal(params.backendNodeId, 200);
    return pointReply(method, { x: 30, y: 40 }) ?? {};
  });
  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    'internal:nth=1;loc=role:button[name="Download"]',
  );
  assert.deepEqual(point, { x: 30, y: 40, sessionId: undefined });
});

test("text locator resolves through browser-side text matching", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /querySelectorAll\('body \*'\)/);
      assert.match(params.expression, /Allow access/);
      return { result: { value: { x: 10, y: 20 } } };
    }
    return {};
  });
  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    "text=Allow access",
  );
  assert.deepEqual(point, { x: 10, y: 20, sessionId: undefined });
});

test("label locator resolves form controls by label text", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /document\.querySelectorAll\('label'\)/);
      assert.match(params.expression, /Email/);
      return { result: { value: { x: 30, y: 40 } } };
    }
    return {};
  });
  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    'loc=label:"Email"',
  );
  assert.deepEqual(point, { x: 30, y: 40, sessionId: undefined });
});

test("test id locator resolves data-testid attributes exactly", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /\[data-testid\]/);
      assert.match(params.expression, /getAttribute\("data-testid"\)/);
      assert.match(params.expression, /=== "submit"/);
      return { result: { value: { x: 30, y: 40 } } };
    }
    return {};
  });
  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    'loc=testid:exact:"submit"',
  );
  assert.deepEqual(point, { x: 30, y: 40, sessionId: undefined });
});

test("scoped locator center uses the matched descendant", async () => {
  const selector = internalSelector("scope", {
    base: "form",
    child: 'loc=testid:exact:"submit"',
  });
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /querySelectorAll\("form"\)/);
      assert.match(params.expression, /\[data-testid\]/);
      return { result: { value: { x: 30, y: 40 } } };
    }
    return {};
  });
  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    selector,
  );
  assert.deepEqual(point, { x: 30, y: 40, sessionId: undefined });
});

/** Run the page-side point picker with a fake DOM. */
function pickPoint(el, elementFromPoint, viewport = { w: 1000, h: 800 }) {
  const doc = { elementFromPoint };
  return new Function(
    "document",
    "innerWidth",
    "innerHeight",
    `return ${POINT_JS}`,
  )(doc, viewport.w, viewport.h)(el);
}

test("a link wrapped across two lines is clicked on a fragment, not in the gap", () => {
  // Union rect of the two line boxes has its centre in the gap between them,
  // where the parent paragraph is the hit target and the click does nothing.
  const el = {
    isConnected: true,
    contains: (n) => n === el,
    getClientRects: () => [
      { x: 700, y: 100, width: 100, height: 20 },
      { x: 100, y: 130, width: 60, height: 20 },
    ],
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 700, height: 50 }),
  };
  const paragraph = { tagName: "P", id: "", className: "" };
  const point = pickPoint(el, (x, y) => {
    const onFirst = x >= 700 && x <= 800 && y >= 100 && y <= 120;
    const onSecond = x >= 100 && x <= 160 && y >= 130 && y <= 150;
    return onFirst || onSecond ? el : paragraph;
  });
  assert.deepEqual(point, { x: 750, y: 110 });

  // The old union centre would have been (450, 125): the gap.
  assert.notDeepEqual(point, { x: 450, y: 125 });
});

test("an element under an overlay reports what intercepts the click", () => {
  const el = {
    isConnected: true,
    contains: (n) => n === el,
    getClientRects: () => [{ x: 10, y: 10, width: 100, height: 20 }],
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 20 }),
  };
  const overlay = { tagName: "DIV", id: "blocker", className: "modal open" };
  const point = pickPoint(el, () => overlay);
  assert.equal(point.intercepted, "div#blocker.modal");
});

test("a detached element is refused before any click is dispatched", () => {
  const el = {
    isConnected: false,
    contains: () => false,
    getClientRects: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  };
  assert.deepEqual(pickPoint(el, () => null), { error: "detached" });
});

test("a bad selector says what is wrong, not the browser's SyntaxError", () => {
  assert.match(
    invalidSelectorMessage("@abc", "SyntaxError: Failed to execute 'querySelectorAll'"),
    /@abc is not a valid ref.*page\.snapshot\(\)/s,
  );
  const css = invalidSelectorMessage(
    "div[",
    "SyntaxError: Failed to execute 'querySelectorAll' on 'Document': 'div[' is not a valid selector.",
  );
  assert.match(css, /Invalid CSS selector "div\[".*getByRole/s);
  assert.doesNotMatch(css, /Failed to execute/);
});
