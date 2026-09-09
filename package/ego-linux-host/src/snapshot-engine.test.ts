import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCdpBridge } from "./cdp-bridge.js";
import { axTreeToSnapshot, snapshotPage } from "./snapshot-engine.js";

/** Minimal injectable transport: records sends and auto-replies. */
function mockTransport() {
  let handler: ((text: string) => void) | undefined;
  const sent: string[] = [];
  const transport = {
    sent,
    send(text: string) {
      sent.push(text);
    },
    onMessage(cb: (text: string) => void) {
      handler = cb;
    },
    deliver(obj: object) {
      assert.ok(handler, "onMessage must be registered");
      handler!(JSON.stringify(obj));
    },
    autoReply(resultOrBuilder: object | ((msg: any) => object)) {
      const prevSend = transport.send.bind(transport);
      transport.send = (text: string) => {
        prevSend(text);
        const msg = JSON.parse(text);
        const reply =
          typeof resultOrBuilder === "function"
            ? resultOrBuilder(msg)
            : { id: msg.id, result: resultOrBuilder };
        queueMicrotask(() => transport.deliver(reply));
      };
    },
  };
  return transport;
}

function manyAxNodes(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    nodeId: String(i + 1),
    ignored: false,
    role: { value: "button" },
    name: { value: `Btn${i}` },
    backendDOMNodeId: 1000 + i,
  }));
}

test("axTreeToSnapshot emits refs with backendNodeId", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: true });
  assert.ok(snap.content.length > 0);
  assert.ok(snap.refs.length > 0);
  assert.equal(typeof snap.refs[0].backendNodeId, "number");
  assert.match(snap.content, /@1/);
});

test("maxResultLength truncates content", () => {
  const snap = axTreeToSnapshot(manyAxNodes(20), { maxResultLength: 1 });
  assert.ok(snap.content.length <= 1);
});

test("axTreeToSnapshot skips ignored and empty generic nodes", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: true });
  const backendIds = snap.refs.map((r) => r.backendNodeId);
  assert.ok(!backendIds.includes(50), "ignored node skipped");
  assert.ok(!backendIds.includes(60), "empty generic skipped");
  assert.ok(backendIds.includes(20), "button kept");
  assert.ok(backendIds.includes(70), "StaticText kept");
});

test("includeActionMarks false omits @N marks but still returns refs", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: false });
  assert.ok(snap.refs.length > 0);
  assert.doesNotMatch(snap.content, /@\d+/);
  assert.match(snap.content, /button/);
});

test("content line format includes role and quoted name", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: true });
  assert.match(snap.content, /@\d+ button "Submit"/);
  assert.match(snap.content, /@\d+ link "Home"/);
  assert.match(snap.content, /@\d+ textbox "Email"/);
});

test("every @N on a line is that node's backendNodeId", async () => {
  // The printed ref is the key the harness resolves with (DOM.resolveNode).
  // A separate counter used to be printed, so refs missed or hit the wrong node.
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: true });
  const printed = snap.content
    .split("\n")
    .map((line) => Number(/^@(\d+) /.exec(line)?.[1]));
  assert.equal(printed.length, snap.refs.length);
  for (let i = 0; i < snap.refs.length; i++) {
    assert.equal(printed[i], snap.refs[i].backendNodeId);
    assert.equal(snap.refs[i].id, snap.refs[i].backendNodeId);
    assert.ok(snap.refs[i].role);
  }
  // Refs are unique, so a @N can never address two nodes.
  assert.equal(new Set(printed).size, printed.length);
});

test("a row is the locator: no duplicated loc= suffix, no echo rows", () => {
  // The suffix used to repeat the row's own role and name, 54% of the bytes.
  const nodes = [
    { role: { value: "heading" }, name: { value: "Security" }, backendDOMNodeId: 1 },
    { role: { value: "StaticText" }, name: { value: "Security" }, backendDOMNodeId: 2 },
    { role: { value: "ListMarker" }, name: { value: "\u2022 " }, backendDOMNodeId: 3 },
    { role: { value: "link" }, name: { value: "Kernel" }, backendDOMNodeId: 4 },
  ];
  const bare = axTreeToSnapshot(nodes, { includeActionMarks: true });
  assert.deepEqual(bare.content.split("\n"), [
    '@1 heading "Security"',
    '@4 link "Kernel"',
  ]);

  // The suffix is still available for a caller that asks for it.
  const withLoc = axTreeToSnapshot(nodes, {
    includeActionMarks: true,
    includeStableLocator: true,
  });
  assert.match(withLoc.content, /@1 heading "Security" loc=role:heading\[name="Security"\]/);
});

test("an ambiguous role+name row carries the disambiguated locator", () => {
  const nodes = [
    { role: { value: "link" }, name: { value: "Jump up" }, backendDOMNodeId: 10 },
    { role: { value: "link" }, name: { value: "Kernel" }, backendDOMNodeId: 11 },
    { role: { value: "link" }, name: { value: "Jump up" }, backendDOMNodeId: 12 },
    { role: { value: "table" }, name: { value: "" }, backendDOMNodeId: 13 },
    { role: { value: "table" }, name: { value: "" }, backendDOMNodeId: 14 },
  ];
  const snap = axTreeToSnapshot(nodes, { includeActionMarks: true });
  assert.deepEqual(snap.content.split("\n"), [
    '@10 link "Jump up" loc=role:link[name="Jump up"] >> nth=0',
    '@11 link "Kernel"',
    '@12 link "Jump up" loc=role:link[name="Jump up"] >> nth=1',
    '@13 table "" loc=role:table[name=""] >> nth=0',
    '@14 table "" loc=role:table[name=""] >> nth=1',
  ]);
  // Every emitted locator is unique: no two rows can claim the same one.
  const emitted = snap.content
    .split("\n")
    .map((line) => line.split(" loc=")[1])
    .filter(Boolean);
  assert.equal(new Set(emitted).size, emitted.length);
});

test("structural rows survive even without a name", () => {
  // Chrome emits lowercase roles; matching only "Row" dropped every table row,
  // which left a table as a flat run of cells with no boundaries.
  const nodes = [
    { role: { value: "row" }, name: { value: "" }, backendDOMNodeId: 1 },
    { role: { value: "cell" }, name: { value: "a" }, backendDOMNodeId: 2 },
    { role: { value: "list" }, name: { value: "" }, backendDOMNodeId: 3 },
    { role: { value: "paragraph" }, name: { value: "" }, backendDOMNodeId: 4 },
    { role: { value: "code" }, name: { value: "" }, backendDOMNodeId: 5 },
    { role: { value: "figure" }, name: { value: "" }, backendDOMNodeId: 6 },
    { role: { value: "generic" }, name: { value: "" }, backendDOMNodeId: 7 },
  ];
  const snap = axTreeToSnapshot(nodes, { includeActionMarks: true });
  assert.deepEqual(
    snap.content.split("\n").map((line) => line.split(" ")[1]),
    ["row", "cell", "list", "paragraph", "code", "figure"],
  );
});

test("snapshotPage enables AX, fetches tree, returns snapshot", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const transport = mockTransport();
  transport.autoReply((msg) => {
    if (msg.method === "Accessibility.enable") {
      return { id: msg.id, result: {} };
    }
    if (msg.method === "Accessibility.getFullAXTree") {
      return { id: msg.id, result: { nodes: ax.nodes } };
    }
    return { id: msg.id, result: {} };
  });
  const cdp = createCdpBridge(transport);
  const snap = await snapshotPage(cdp, "sess-1", { includeActionMarks: true });
  assert.ok(snap.refs.length > 0);
  assert.match(snap.content, /@1/);
  const methods = transport.sent.map((t) => JSON.parse(t).method);
  assert.ok(methods.includes("Accessibility.enable"));
  assert.ok(methods.includes("Accessibility.getFullAXTree"));
  const treeCall = transport.sent
    .map((t) => JSON.parse(t))
    .find((m) => m.method === "Accessibility.getFullAXTree");
  assert.equal(treeCall.sessionId, "sess-1");
});

test("snapshotPage scoped to a node reads only that subtree", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const transport = mockTransport();
  transport.autoReply((msg) => {
    if (msg.method === "Accessibility.queryAXTree") {
      return { id: msg.id, result: { nodes: ax.nodes.slice(0, 2) } };
    }
    if (msg.method === "Accessibility.getFullAXTree") {
      throw new Error("a scoped snapshot must not fetch the whole tree");
    }
    return { id: msg.id, result: {} };
  });
  const cdp = createCdpBridge(transport);
  const snap = await snapshotPage(cdp, "sess-1", {
    includeActionMarks: true,
    rootBackendNodeId: 77,
  });
  const query = transport.sent
    .map((t) => JSON.parse(t))
    .find((m) => m.method === "Accessibility.queryAXTree");
  assert.equal(query.params.backendNodeId, 77);
  assert.ok(snap.refs.length > 0);
  assert.ok(snap.refs.length <= 2);
});

test("an accessibility timeout says what it usually means and what to do", async () => {
  const transport = mockTransport();
  transport.autoReply((msg) => {
    if (msg.method === "Accessibility.enable") return { id: msg.id, result: {} };
    if (msg.method === "DOM.getDocument") {
      return { id: msg.id, result: { root: { backendNodeId: 1 } } };
    }
    throw new Error("CDP timeout after 15000ms: Accessibility.queryAXTree");
  });
  const cdp = createCdpBridge(transport);
  await assert.rejects(
    () => snapshotPage(cdp, "sess-1", {}),
    (error: any) => {
      assert.equal(error.error_code, "EGO_SNAPSHOT_FAILED");
      assert.match(error.message, /CDP timeout after 15000ms/);
      assert.match(error.message, /only for its focused tab/);
      assert.match(error.message, /renderer stuck in a long task/);
      // The advice must not sell a mitigation that was measured not to work.
      assert.match(error.message, /does not help/);
      return true;
    },
  );
});

test("snapshotPage throws EGO_SNAPSHOT_FAILED on CDP failure", async () => {
  const transport = mockTransport();
  transport.autoReply((msg) => ({
    id: msg.id,
    error: { code: -32000, message: "AX boom" },
  }));
  const cdp = createCdpBridge(transport);
  await assert.rejects(
    () => snapshotPage(cdp, "sess-x"),
    (err: any) => {
      assert.equal(err.error_code, "EGO_SNAPSHOT_FAILED");
      assert.match(String(err.message), /AX boom|snapshot|Accessibility/i);
      return true;
    },
  );
});
