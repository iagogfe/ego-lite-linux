import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  browserCdp,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import {
  drainEvents,
  screenshot,
  snapshot,
} from "../../dist/src/driver/observe.js";
import { describeSelector } from "../../dist/src/locator-query.js";
import { innerText } from "../../dist/src/driver/locator.js";
import { setOverrides } from "../../dist/src/state.js";

function withCdpRuntime(fn) {
  const previous = globalThis.ego;
  const sent = [];
  const runtime = {
    async listTabs() {
      return {
        tabs: [
          {
            targetId: "target-1",
            active: true,
            title: "Example",
            url: "https://example.com/",
          },
        ],
      };
    },
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      sent.push(request);
      let result = {};
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: "session-1" };
      } else if (request.method === "Page.captureScreenshot") {
        result = { data: Buffer.from("png").toString("base64") };
      } else if (request.method === "Runtime.evaluate") {
        result = { result: { value: "1" } };
      }
      queueMicrotask(() =>
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result })),
      );
    },
    emit(method, params) {
      runtime.onCDPMessage(
        JSON.stringify({ sessionId: "session-1", method, params }),
      );
    },
  };
  globalThis.ego = runtime;
  invalidateSession();
  return Promise.resolve()
    .then(() => fn({ runtime, sent }))
    .finally(() => {
      invalidateSession();
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("screenshot skips page metric JavaScript while a native dialog is pending", async () => {
  const writes = [];
  const restore = setOverrides({
    async writeFile(path, data) {
      writes.push({ path, data });
    },
  });
  try {
    await withCdpRuntime(async ({ runtime, sent }) => {
      await browserCdp("Runtime.evaluate", { expression: "document.title" });
      runtime.emit("Page.javascriptDialogOpening", {
        type: "alert",
        message: "Blocked",
        url: "https://example.com/",
      });
      sent.length = 0;

      await screenshot({ path: "/tmp/ego-browser-dialog-shot.png" });

      assert.equal(
        sent.some((request) => request.method === "Runtime.evaluate"),
        false,
      );
      const shot = sent.find(
        (request) => request.method === "Page.captureScreenshot",
      );
      assert.deepEqual(shot.params, {
        format: "png",
        captureBeyondViewport: false,
      });
    });
  } finally {
    restore();
  }

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/tmp/ego-browser-dialog-shot.png");
});

test("screenshot creates a missing parent directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ego-browser-observe-"));
  const path = join(tempDir, "nested", "shot.png");
  try {
    await withCdpRuntime(() => screenshot({ path, raw: true }));
    assert.equal((await readFile(path)).toString(), "png");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("drainEvents returns the current event array synchronously", () => {
  assert.ok(Array.isArray(drainEvents()));
});

test("a capped snapshot says how much it dropped, and keeps every ref", async () => {
  const previous = globalThis.ego;
  const content = "x".repeat(5000);
  globalThis.ego = {
    async snapshot(options) {
      // The cap is ours: the host must be asked for the whole page, otherwise
      // the marker could not name the real size and refs would be partial.
      assert.equal("maxResultLength" in options, false);
      return { content, refs: [{ backendNodeId: 42, role: "button" }] };
    },
    sendCDPMessage() {},
  };
  try {
    const capped = await snapshot({ maxResultLength: 100 });
    // One row of 5000 x's: no room for the full marker, so the short one is used.
    assert.ok(capped.length <= 100, `got ${capped.length}`);
    assert.match(
      capped,
      /\[snapshot truncated: \d+ of 5000 chars, \d+ of 1 rows shown/,
    );
    assert.equal(await snapshot(), content);
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("errors name the selector the agent wrote, not the internal form", () => {
  assert.equal(
    describeSelector(
      "internal:scope:" +
        encodeURIComponent(
          JSON.stringify({ base: "loc=role:region", child: "loc=role:link" }),
        ),
    ),
    "loc=role:region >> loc=role:link",
  );
  assert.equal(
    describeSelector("internal:nth=0;loc=role:searchbox"),
    "loc=role:searchbox (match #1)",
  );
  assert.equal(
    describeSelector("internal:last;loc=css:a"),
    "loc=css:a (last match)",
  );
  assert.equal(describeSelector("#plain"), "#plain");
});

test("a @N from the snapshot resolves to the element that line names, past the cut too", async () => {
  // Literal shape of the host snapshot engine: the printed @N is the node's
  // backendNodeId, which is the key DOM.resolveNode takes. When the two drifted
  // apart, refs either missed or hit a different element in silence.
  const rows = [
    { id: 10, role: "heading", name: "Example Domain" },
    { id: 13, role: "link", name: "Learn more" },
    { id: 4821, role: "button", name: "Far below the cut" },
  ];
  const content = rows
    .map((r) => `@${r.id} ${r.role} ${JSON.stringify(r.name)}`)
    .join("\n");
  const previous = globalThis.ego;
  globalThis.ego = {
    async snapshot() {
      return {
        content,
        refs: rows.map((r) => ({
          id: r.id,
          backendNodeId: r.id,
          role: r.role,
          name: r.name,
        })),
      };
    },
    sendCDPMessage() {},
  };
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      if (method === "DOM.resolveNode") {
        return {
          object: {
            objectId: `node-${params.backendNodeId}`,
            className: "HTMLElement",
          },
        };
      }
      if (method === "Runtime.callFunctionOn") {
        const id = Number(String(params.objectId).replace("node-", ""));
        return { result: { value: rows.find((r) => r.id === id)?.name } };
      }
      return {};
    },
  });
  try {
    // Cap so only the first row survives in the text (80 chars leaves room for
    // the short marker only).
    const capped = await snapshot({ maxResultLength: 80 });
    assert.match(capped, /truncated: \d+ of \d+ chars/);
    assert.equal(capped.includes("Far below the cut"), false);

    for (const row of rows) {
      assert.equal(await innerText(`@${row.id}`), row.name);
    }
  } finally {
    restore();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a text or document ref resolves to the element carrying the text", async () => {
  const previous = globalThis.ego;
  globalThis.ego = {
    async snapshot() {
      return {
        content: '@19 StaticText "Example Domain"',
        refs: [
          {
            id: 19,
            backendNodeId: 19,
            role: "StaticText",
            name: "Example Domain",
          },
        ],
      };
    },
    sendCDPMessage() {},
  };
  const calls = [];
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      calls.push(method);
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "text-node", className: "Text" } };
      }
      if (
        method === "Runtime.callFunctionOn" &&
        params.objectId === "text-node"
      ) {
        // The promotion hop: text node -> its element.
        assert.match(
          params.functionDeclaration,
          /nodeType===3\?this\.parentElement/,
        );
        return { result: { objectId: "element-node" } };
      }
      return { result: { value: "Example Domain" } };
    },
  });
  try {
    await snapshot();
    assert.equal(await innerText("@19"), "Example Domain");
  } finally {
    restore();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("truncation lands on a line boundary and counts what it dropped", async () => {
  // A mid-line cut once produced a half-written ref (@1812 -> @18) that
  // resolved to a different element without any error.
  const rows = [
    '@11 heading "One"',
    '@1812 region "Precursors, a long enough row to force a cut here"',
    '@1900 heading "Two, also long enough to matter for the budget"',
    '@2000 StaticText "tail, padded so the content exceeds the cap"',
  ];
  const previous = globalThis.ego;
  globalThis.ego = {
    async snapshot() {
      return { content: rows.join("\n"), refs: [] };
    },
    sendCDPMessage() {},
  };
  try {
    // A cap that falls inside "@1812 region ..." must not emit a partial row.
    const capped = await snapshot({ maxResultLength: 100 });
    assert.ok(capped.length <= 100, `got ${capped.length}`);
    const body = capped.split("\n[")[0];
    assert.deepEqual(body.split("\n"), ['@11 heading "One"']);
    assert.match(capped, /\[(?:snapshot )?truncated: \d+ of \d+ chars/);
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a ref whose element left the page fails instead of reading the dead node", async () => {
  const previous = globalThis.ego;
  globalThis.ego = {
    async snapshot() {
      return {
        content: '@13 link "Learn more"',
        refs: [{ id: 13, backendNodeId: 13, role: "link", name: "Learn more" }],
      };
    },
    sendCDPMessage() {},
  };
  const restore = setOverrides({
    cdpOverride: async (method) => {
      if (method === "DOM.resolveNode") {
        return {
          object: { objectId: "dead-node", className: "HTMLAnchorElement" },
        };
      }
      if (method === "Runtime.callFunctionOn") {
        // The page-side guard: this.isConnected === false.
        return {
          result: {},
          exceptionDetails: {
            exception: { description: "Error: ego-browser:detached" },
          },
        };
      }
      return {};
    },
  });
  try {
    await snapshot();
    await assert.rejects(
      () => innerText("@13"),
      /Ref @13 is stale.*Re-run page\.snapshot\(\)/s,
    );
  } finally {
    restore();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("the truncation marker counts against maxResultLength", async () => {
  const previous = globalThis.ego;
  const content = Array.from(
    { length: 60 },
    (_, i) => `@${100 + i} StaticText "row ${i} padded out a little"`,
  ).join("\n");
  globalThis.ego = {
    async snapshot() {
      return { content, refs: [] };
    },
    sendCDPMessage() {},
  };
  try {
    for (const cap of [600, 900, 1500]) {
      const out = await snapshot({ maxResultLength: cap });
      assert.ok(out.length <= cap, `cap ${cap}: got ${out.length} chars`);
      assert.match(out, /snapshot truncated/);
      // Still a clean line boundary before the marker.
      const body = out.split("\n[snapshot truncated: ")[0];
      for (const row of body.split("\n")) {
        assert.ok(content.includes(row), `partial row: ${JSON.stringify(row)}`);
      }
    }
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("snapshot rejects an option nobody reads, on both entry points", async () => {
  const previous = globalThis.ego;
  globalThis.ego = {
    async snapshot() {
      return { content: '@1 heading "x"', refs: [] };
    },
    sendCDPMessage() {},
  };
  try {
    await assert.rejects(
      () => snapshot({ maxResultLength: 100, includeStableLocatr: true }),
      /unknown option "includeStableLocatr".*Valid options: includeActionMarks, includeStableLocator, maxResultLength/s,
    );
    // The documented ones stay accepted.
    assert.equal(
      typeof (await snapshot({ includeStableLocator: true })),
      "string",
    );
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a cap smaller than the marker still fits, and a useless cap is refused", async () => {
  const previous = globalThis.ego;
  const content = Array.from(
    { length: 40 },
    (_, i) => `@${100 + i} link "row ${i}"`,
  ).join("\n");
  globalThis.ego = {
    async snapshot() {
      return { content, refs: [] };
    },
    sendCDPMessage() {},
  };
  try {
    for (const cap of [80, 120, 200, 326, 400, 600]) {
      const out = await snapshot({ maxResultLength: cap });
      assert.ok(out.length <= cap, `cap ${cap}: got ${out.length}`);
      assert.match(out, /truncated/);
    }
    await assert.rejects(
      () => snapshot({ maxResultLength: 40 }),
      /maxResultLength must be at least 80 \(or 0 for the whole page\); got 40/,
    );
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a ref from a page that navigated away is refused, not read", async () => {
  // backendNodeIds are per-document and Chrome reuses them, so an old @N could
  // read an unrelated element of the new page and look successful.
  const previous = globalThis.ego;
  globalThis.ego = {
    async snapshot() {
      return {
        content: '@13 link "Jump to content"',
        refs: [
          { id: 13, backendNodeId: 13, role: "link", name: "Jump to content" },
        ],
      };
    },
    sendCDPMessage() {},
  };
  let token = "doc-1";
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      if (
        method === "Runtime.evaluate" &&
        /__egoRefDoc/.test(params.expression)
      ) {
        return { result: { value: token } };
      }
      if (method === "DOM.resolveNode") {
        return {
          object: { objectId: "node-13", className: "HTMLAnchorElement" },
        };
      }
      if (method === "Runtime.callFunctionOn") {
        if (/isConnected/.test(params.functionDeclaration)) {
          return { result: { objectId: params.objectId } };
        }
        return { result: { value: "Jump to content" } };
      }
      return {};
    },
  });
  try {
    await snapshot();
    assert.equal(await innerText("@13"), "Jump to content");
    token = "doc-2"; // the tab navigated
    await assert.rejects(
      () => innerText("@13"),
      /Ref @13 was taken from a page that is no longer loaded.*page\.snapshot\(\)/s,
    );
  } finally {
    restore();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});
