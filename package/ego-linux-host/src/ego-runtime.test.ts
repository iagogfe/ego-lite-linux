import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { CdpBridge, CdpPageTarget } from "./cdp-bridge.js";
import { actionLabel, createEgoRuntime } from "./ego-runtime.js";
import { SpaceManager } from "./space-manager.js";

type FakeCdp = CdpBridge & {
  targets: CdpPageTarget[];
  rawSent: object[];
  closedTargets: string[];
  messageHandlers: Set<(msg: any) => void>;
  deliverMessage(msg: any): void;
};

function makeFakeCdp(initial: CdpPageTarget[] = []): FakeCdp {
  let nextTarget = 1;
  const fake: FakeCdp = {
    targets: [...initial],
    rawSent: [],
    closedTargets: [],
    messageHandlers: new Set(),
    deliverMessage(msg: any) {
      for (const h of fake.messageHandlers) h(msg);
    },
    async send(method: string, params?: object) {
      if (method === "Target.closeTarget") {
        const tid = (params as { targetId?: string })?.targetId;
        if (tid) fake.closedTargets.push(tid);
        return { success: true };
      }
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              role: { value: "button" },
              name: { value: "Go" },
              backendDOMNodeId: 42,
            },
          ],
        };
      }
      return {};
    },
    sendRaw(payload: object) {
      fake.rawSent.push(payload);
    },
    onMessage(handler) {
      fake.messageHandlers.add(handler);
      return () => fake.messageHandlers.delete(handler);
    },
    async close() {},
    async listPageTargets() {
      return fake.targets.map((t) => ({ ...t }));
    },
    async createTarget(url: string) {
      const targetId = `T${nextTarget++}`;
      fake.targets.push({
        targetId,
        title: "",
        url,
        type: "page",
      });
      return targetId;
    },
    async attach(targetId: string) {
      return `session-${targetId}`;
    },
  };
  return fake;
}


/** True while any of the promises is still unsettled. */
async function pending(promises: Promise<unknown>[]): Promise<boolean> {
  const marker = Symbol("pending");
  const states = await Promise.all(
    promises.map((p) =>
      Promise.race([p.catch(() => undefined), Promise.resolve(marker)]),
    ),
  );
  return states.includes(marker);
}

function setup(opts?: { targets?: CdpPageTarget[] }) {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp(opts?.targets);
  const ensureSession = async () => "sess-1";
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession,
  });
  return { sm, fakeCdp, runtime, ensureSession };
}

/** setup() com tempos curtos, para não esperar segundos no teste. */
function setupWithIdle(idleAfterMs: number, labelHoldMs?: number) {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp();
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession: async () => "sess-1",
    idleAfterMs,
    ...(labelHoldMs === undefined ? {} : { labelHoldMs }),
  });
  return { sm, fakeCdp, runtime };
}

test("snapshot rejects under user control", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(1); // user
  await assert.rejects(
    () => runtime.handle("snapshot", {}),
    (err: any) => err.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  void fakeCdp;
});

test("snapshot rejects when no space selected", async () => {
  const { runtime } = setup();
  await assert.rejects(
    () => runtime.handle("snapshot", {}),
    (err: any) => err.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});

test("snapshot works for agent-owned space", async () => {
  const { sm, runtime } = setup();
  const space = sm.createAgentSpace("job");
  sm.use(space.id);
  const result = await runtime.handle("snapshot", {
    includeActionMarks: true,
  });
  assert.ok(result.content.includes("button"));
  assert.ok(Array.isArray(result.refs));
  assert.equal(result.refs[0]?.backendNodeId, 42);
});

test("listTabs filters to selected space only", async () => {
  const { sm, fakeCdp, runtime } = setup({
    targets: [
      {
        targetId: "user-tab",
        title: "User",
        url: "https://u.example",
        type: "page",
      },
      {
        targetId: "agent-tab",
        title: "Agent",
        url: "https://a.example",
        type: "page",
      },
    ],
  });
  sm.adoptOrphanTargets(["user-tab"]);
  const agent = sm.createAgentSpace("agent-job");
  sm.use(agent.id);
  sm.assignTarget("agent-tab");

  const result = await runtime.handle("listTabs", {});
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0].targetId, "agent-tab");
  assert.equal(result.tabs[0].url, "https://a.example");
  void fakeCdp;
});

test("listTabs returns empty for agent space with no tabs (not user tabs)", async () => {
  const { sm, runtime } = setup({
    targets: [
      {
        targetId: "user-only",
        title: "Mine",
        url: "https://user.example",
        type: "page",
      },
    ],
  });
  sm.adoptOrphanTargets(["user-only"]);
  const agent = sm.createAgentSpace("empty-agent");
  sm.use(agent.id);

  const result = await runtime.handle("listTabs", {});
  assert.deepEqual(result.tabs, []);
});

test("findReusableTab never takes a tab from another agent space", async () => {
  const { sm, runtime } = setup({
    targets: [
      {
        targetId: "other-agent-tab",
        title: "Other agent",
        url: "https://example.com/previous",
        type: "page",
      },
      {
        targetId: "user-tab",
        title: "User Example",
        url: "https://example.com/user",
        type: "page",
      },
    ],
  });
  sm.adoptOrphanTargets(["user-tab"]);
  const otherSpace = sm.createAgentSpace("other-job");
  sm.assignTarget("other-agent-tab", otherSpace.id);
  const currentSpace = sm.createAgentSpace("current-job");
  sm.use(currentSpace.id);

  const result = await runtime.handle("findReusableTab", {
    url: "https://example.com/current",
    match: "origin",
  });

  assert.equal(result, null);
  // The other space keeps its tab; this one gained nothing.
  assert.deepEqual(sm.targetsForSelected(), []);
  assert.deepEqual(
    sm.list().find((space) => space.id === otherSpace.id)?.targetIds,
    ["other-agent-tab"],
  );
});

test("findReusableTab reuses a matching tab of the selected space", async () => {
  const { sm, runtime } = setup({
    targets: [
      {
        targetId: "own-tab",
        title: "Mine",
        url: "https://example.com/previous",
        type: "page",
      },
    ],
  });
  const current = sm.createAgentSpace("current-job");
  sm.use(current.id);
  sm.assignTarget("own-tab");

  assert.deepEqual(
    await runtime.handle("findReusableTab", {
      url: "https://example.com/current",
      match: "origin",
    }),
    { targetId: "own-tab", title: "Mine", url: "https://example.com/previous" },
  );
});

test("findReusableTab ignores handed-off tabs", async () => {
  const { sm, runtime } = setup({
    targets: [
      {
        targetId: "handed-off-tab",
        title: "Example",
        url: "https://example.com/previous",
        type: "page",
      },
    ],
  });
  const handedOff = sm.createAgentSpace("handed-off");
  sm.assignTarget("handed-off-tab", handedOff.id);
  sm.use(handedOff.id);
  sm.handOff();
  const current = sm.createAgentSpace("current");
  sm.use(current.id);

  const result = await runtime.handle("findReusableTab", {
    url: "https://example.com/current",
    match: "origin",
  });

  assert.equal(result, null);
  assert.deepEqual(sm.targetsForSelected(), []);
});

test("createTab creates target and assigns to selected space", async () => {
  const { sm, runtime } = setup();
  const agent = sm.createAgentSpace("tabs");
  sm.use(agent.id);

  const created = await runtime.handle("createTab", {
    url: "https://example.com",
  });
  assert.ok(created.targetId);
  assert.deepEqual(sm.targetsForSelected(), [created.targetId]);

  const listed = await runtime.handle("listTabs", {});
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0].targetId, created.targetId);
  assert.equal(listed.tabs[0].url, "https://example.com");
});

test("createTab gives the new tab the configured viewport", async () => {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp();
  const sent: any[] = [];
  const origSend = fakeCdp.send.bind(fakeCdp);
  fakeCdp.send = async (method: string, params?: object, sessionId?: string) => {
    sent.push({ method, params, sessionId });
    return origSend(method, params, sessionId);
  };
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession: async () => "sess-1",
    viewport: { width: 1280, height: 900 },
  });
  const space = sm.createAgentSpace("vp");
  sm.use(space.id);

  const created = await runtime.handle("createTab", { url: "https://x.test" });

  const metrics = sent.find(
    (c) => c.method === "Emulation.setDeviceMetricsOverride",
  );
  assert.ok(metrics, "a new agent tab must get the launch viewport");
  assert.equal(metrics.params.width, 1280);
  assert.equal(metrics.params.height, 900);
  assert.equal(metrics.sessionId, `session-${created.targetId}`);
});

test("createTab leaves the viewport alone when none is configured", async () => {
  const { runtime, sm, fakeCdp } = setup();
  const sent: string[] = [];
  const origSend = fakeCdp.send.bind(fakeCdp);
  fakeCdp.send = async (method: string, params?: object, sessionId?: string) => {
    sent.push(method);
    return origSend(method, params, sessionId);
  };
  const space = sm.createAgentSpace("headed");
  sm.use(space.id);

  await runtime.handle("createTab", { url: "https://x.test" });

  assert.equal(sent.includes("Emulation.setDeviceMetricsOverride"), false);
});

test("createTab fails without selected space", async () => {
  const { runtime } = setup();
  await assert.rejects(
    () => runtime.handle("createTab", { url: "https://x" }),
    (err: any) => err.error_code === "EGO_TASK_SPACE_NOT_SELECTED",
  );
});

test("creating a task space closes tabs abandoned by earlier agent sessions", async () => {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp();
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession: async () => "sess-1",
    staleSpaceTtlMs: 1,
  });

  const old = sm.createAgentSpace("yesterday");
  sm.assignTarget("old-agent-tab", old.id);
  sm.assignTarget("user-tab", 1);
  (sm as any).spaces.find((s: any) => s.id === old.id).lastUsedAt = 0;
  (sm as any).spaces.find((s: any) => s.id === 1).lastUsedAt = 0;

  await runtime.handle("createTaskSpace", { name: "today" });

  assert.deepEqual(fakeCdp.closedTargets, ["old-agent-tab"]);
  assert.equal(sm.list().some((s) => s.id === old.id), false);
  assert.equal(sm.spaceIdForTarget("user-tab"), 1);
});

test("snapshot activates its own tab before reading the AX tree", async () => {
  const { sm, runtime, fakeCdp } = setup();
  const calls: string[] = [];
  const origSend = fakeCdp.send.bind(fakeCdp);
  fakeCdp.send = async (method: string, params?: any, sessionId?: string) => {
    calls.push(method);
    return origSend(method, params, sessionId);
  };
  const space = sm.createAgentSpace("reader");
  sm.use(space.id);
  const tab = await runtime.handle("createTab", { url: "https://x.test" });
  // Someone else's tab holds focus, the normal case for a task space.
  await runtime.handle("sendCDPMessage", {
    payload: JSON.stringify({
      method: "Target.activateTarget",
      params: { targetId: "other-tab" },
    }),
  });
  calls.length = 0;

  await runtime.handle("snapshot", {});

  const activated = calls.indexOf("Target.activateTarget");
  const read = calls.findIndex((m) => m.startsWith("Accessibility."));
  assert.ok(activated >= 0, "the tab must be activated");
  assert.ok(
    activated < read,
    // Chrome only answers accessibility for the focused tab.
    `activation must precede the AX read, got ${calls.join(",")}`,
  );
  assert.equal(sm.activeTargetForSelected(), tab.targetId);
});

test("concurrent snapshots take turns instead of stealing focus", async () => {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp();
  const order: string[] = [];
  let inFlight = 0;
  let overlapped = false;
  fakeCdp.send = async (method: string) => {
    if (method === "Accessibility.queryAXTree" || method === "Accessibility.getFullAXTree") {
      if (++inFlight > 1) overlapped = true;
      order.push("start");
      await delay(20);
      inFlight--;
      order.push("end");
      return { nodes: [] };
    }
    return {};
  };
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession: async () => "sess-1",
  });
  const a = sm.createAgentSpace("a");
  sm.assignTarget("ta", a.id);
  sm.use(a.id);

  // Three different connections: the lease is per client, so one client's own
  // reads may overlap, but two clients must never read at the same time.
  await Promise.all(
    ["c1", "c2", "c3"].map((clientId) =>
      sm.runForClient(clientId, () => {
        sm.use(a.id);
        return runtime.handle("snapshot", {});
      }),
    ),
  );

  assert.equal(overlapped, false, "AX reads overlapped; focus would be stolen");
  assert.deepEqual(order, ["start", "end", "start", "end", "start", "end"]);
});

test("a harness AX read holds the focus turn until its reply arrives", async () => {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp();
  let axReading = false;
  let snapshotStolenFocus = false;
  fakeCdp.send = async (method: string) => {
    if (method.startsWith("Accessibility.")) {
      // A snapshot must not read while the harness's own read is in flight.
      if (axReading) snapshotStolenFocus = true;
      return { nodes: [] };
    }
    return {};
  };
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession: async () => "sess-1",
  });
  runtime.attachCdpForwarding();
  const space = sm.createAgentSpace("role-reader");
  sm.assignTarget("t-role", space.id);

  // Client 1 fires a raw AX read through the harness path (fire and forget).
  await sm.runForClient("c1", () => {
    sm.use(space.id);
    return runtime.handle("sendCDPMessage", {
      payload: JSON.stringify({
        id: 7,
        method: "Accessibility.getFullAXTree",
        params: {},
      }),
    });
  });
  axReading = true;

  // Client 2's snapshot must queue behind it, not read immediately.
  const snapshot = sm.runForClient("c2", () => {
    sm.use(space.id);
    return runtime.handle("snapshot", {});
  });
  await delay(50);
  assert.equal(
    snapshotStolenFocus,
    false,
    "snapshot read while the harness still held the focus turn",
  );

  // The reply releases the turn (plus the grace window).
  axReading = false;
  fakeCdp.deliverMessage({ id: 1_000_000_000, result: { nodes: [] } });
  await snapshot;
});

test("a late harness reply does not hand the lease away mid-snapshot", async () => {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp();
  let snapshotReading = false;
  let stolenMidSnapshot = false;
  const waiting: Array<() => void> = [];
  fakeCdp.send = async (method: string) => {
    if (method === "Accessibility.getFullAXTree") {
      snapshotReading = true;
      await new Promise<void>((r) => waiting.push(r));
      snapshotReading = false;
      return { nodes: [] };
    }
    if (method === "Target.activateTarget" && snapshotReading) {
      // Another client focusing a tab while this read is in flight kills it.
      stolenMidSnapshot = true;
    }
    return {};
  };
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession: async () => "sess-1",
  });
  runtime.attachCdpForwarding();
  // Two spaces with their own tabs: stealing focus means switching tab.
  const space = sm.createAgentSpace("late-reply");
  sm.assignTarget("t-late", space.id);
  const otherSpace = sm.createAgentSpace("other");
  sm.assignTarget("t-other", otherSpace.id);

  // c1 fires a harness AX read, then starts a snapshot before the reply lands.
  await sm.runForClient("c1", () => {
    sm.use(space.id);
    return runtime.handle("sendCDPMessage", {
      payload: JSON.stringify({ id: 5, method: "Accessibility.getFullAXTree" }),
    });
  });
  const snapshot = sm.runForClient("c1", () => {
    sm.use(space.id);
    return runtime.handle("snapshot", {});
  });
  await delay(20);
  // c2 queues up, so the lease has somewhere to go.
  const other = sm.runForClient("c2", () => {
    sm.use(otherSpace.id);
    return runtime.handle("snapshot", {});
  });
  await delay(10);

  // The late reply to c1's harness read arrives while c1's snapshot is reading.
  fakeCdp.deliverMessage({ id: 1_000_000_000, result: { nodes: [] } });
  await delay(20);
  const stolen = stolenMidSnapshot;

  // Let both finish (each read waits on its own release) before asserting, so
  // a failure reports the problem instead of hanging the runner.
  for (let i = 0; i < 6 && (await pending([snapshot, other])); i++) {
    waiting.splice(0).forEach((r) => r());
    await delay(10);
  }
  await Promise.all([snapshot, other].map((p) => p.catch(() => undefined)));

  assert.equal(stolen, false, "the lease moved while a snapshot was mid-read");
});

test("focusing a tab waits its turn instead of cutting a read short", async () => {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp();
  let reading = false;
  let cutShort = false;
  const waiting: Array<() => void> = [];
  fakeCdp.send = async (method: string) => {
    if (method === "Accessibility.getFullAXTree") {
      reading = true;
      await new Promise<void>((r) => waiting.push(r));
      reading = false;
      return { nodes: [] };
    }
    return {};
  };
  fakeCdp.sendRaw = (payload: any) => {
    if (payload?.method === "Target.activateTarget" && reading) cutShort = true;
  };
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession: async () => "sess-1",
  });
  const reader = sm.createAgentSpace("reader");
  sm.assignTarget("t-read", reader.id);
  const opener = sm.createAgentSpace("opener");
  sm.assignTarget("t-open", opener.id);

  const read = sm.runForClient("reader", () => {
    sm.use(reader.id);
    return runtime.handle("snapshot", {});
  });
  await delay(20);

  // Another client opening/reusing a tab activates it — the harness does this
  // on every openOrReuseTab, and it used to hang the read above for ~16s.
  const activate = sm.runForClient("opener", () => {
    sm.use(opener.id);
    return runtime.handle("sendCDPMessage", {
      payload: JSON.stringify({
        method: "Target.activateTarget",
        params: { targetId: "t-open" },
      }),
    });
  });
  await delay(30);
  assert.equal(cutShort, false, "a tab was focused while a read was in flight");

  waiting.splice(0).forEach((r) => r());
  await read;
  await activate;
});

test("a read whose tab stays stuck is failed instead of re-queued forever", async () => {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp();
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession: async () => "sess-1",
    focusMaxMs: 40,
  });
  const events: any[] = [];
  runtime.onEvent((ev) => events.push(ev));
  runtime.attachCdpForwarding();
  const stuck = sm.createAgentSpace("stuck");
  sm.assignTarget("t-stuck", stuck.id);
  const other = sm.createAgentSpace("other");
  sm.assignTarget("t-other", other.id);

  // A tab that never answers: the reply for this id never arrives.
  await sm.runForClient("stuck-client", () => {
    sm.use(stuck.id);
    return runtime.handle("sendCDPMessage", {
      payload: JSON.stringify({ id: 9, method: "Accessibility.getFullAXTree" }),
    });
  });
  // Someone waiting is what makes the deadline hand the turn over.
  const waiter = sm.runForClient("waiter", () => {
    sm.use(other.id);
    return runtime.handle("snapshot", {});
  });
  await delay(250);

  // Preempted twice, the client is answered with an error rather than left
  // waiting out its own 30s CDP timeout while holding a turn every 40ms.
  const failure = events.find((ev) => {
    if (ev.event !== "cdp.message") return false;
    const msg = JSON.parse(ev.params.payload);
    return msg.id === 9 && msg.error;
  });
  assert.ok(failure, "the stuck read was never answered");
  assert.match(failure.params.payload, /renderer looks stuck/);
  await waiter;
});

test("a wedged read gives up the focus turn instead of holding the queue", async () => {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp();
  const wedged = { resolve: () => {} };
  fakeCdp.send = async (method: string) => {
    if (method === "Accessibility.getFullAXTree") {
      // Never answers, like a wedged renderer.
      await new Promise<void>((r) => (wedged.resolve = r));
      return { nodes: [] };
    }
    return {};
  };
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession: async () => "sess-1",
    focusMaxMs: 100,
  });
  const space = sm.createAgentSpace("wedge");
  sm.assignTarget("t-wedge", space.id);

  const stuck = sm.runForClient("stuck", () => {
    sm.use(space.id);
    return runtime.handle("snapshot", {});
  });
  await delay(20);

  // A healthy client's own AX read: it needs the same turn, so it is the one
  // that would wait out the wedge without a cap.
  fakeCdp.send = async (method: string) =>
    method === "Accessibility.getFullAXTree" ? { nodes: [] } : {};
  const t = Date.now();
  const served = await Promise.race([
    sm.runForClient("healthy", () => {
      sm.use(space.id);
      return runtime.handle("snapshot", {});
    }),
    delay(1000).then(() => "stuck" as const),
  ]);
  const waited = Date.now() - t;
  assert.notEqual(served, "stuck", "healthy client waited out the wedge");
  assert.ok(waited < 300, `healthy client waited ${waited}ms behind a wedge`);

  wedged.resolve();
  await stuck.catch(() => undefined);
});

test("listTaskSpaces reports tabs per space without selecting one", async () => {
  const { sm, runtime } = setup();
  const work = sm.createAgentSpace("work");
  sm.use(work.id);
  const created = await runtime.handle("createTab", {
    url: "https://example.com/a",
  });
  // A user-owned space holds the person's own browsing.
  sm.assignTarget("user-tab", 1);
  sm.clearSelection();

  const { taskSpaces } = await runtime.handle("listTaskSpaces", {});
  const agentSpace = taskSpaces.find((s: any) => s.id === work.id);
  assert.equal(agentSpace.tabCount, 1);
  assert.deepEqual(agentSpace.tabs, [
    {
      targetId: created.targetId,
      title: "",
      url: "https://example.com/a",
      active: true,
    },
  ]);

  const userSpace = taskSpaces.find((s: any) => s.id === 1);
  assert.equal(userSpace.tabCount, 0, "counts only tabs Chrome still has");
  assert.equal("tabs" in userSpace, false, "user browsing urls stay private");
  // Listing must not have picked a space for this client.
  assert.equal(sm.selected(), null);
});

test("task space create / use / claim / handOff / takeOver", async () => {
  const { sm, runtime } = setup();

  const listed0 = await runtime.handle("listTaskSpaces", {});
  assert.ok(listed0.taskSpaces.some((s: any) => s.id === 1));

  const created = await runtime.handle("createTaskSpace", { name: "work" });
  assert.equal(created.name, "work");
  assert.equal(created.ownership, "agent");
  assert.equal("targetIds" in created, false);

  const used = await runtime.handle("useTaskSpace", { id: created.id });
  assert.equal(used.id, created.id);
  assert.equal(sm.selected()?.id, created.id);

  await runtime.handle("handOffTaskSpace", {});
  assert.equal(sm.selected()?.ownership, "agentDelegatedToUser");
  assert.equal(sm.isPageControlBlocked(), true);

  await runtime.handle("takeOverTaskSpace", {});
  assert.equal(sm.selected()?.ownership, "agent");
  assert.equal(sm.isPageControlBlocked(), false);

  sm.use(1);
  const claimed = await runtime.handle("claimTaskSpace", {
    id: 1,
    name: "claimed-user",
  });
  assert.equal(claimed.ownership, "agent");
  assert.equal(claimed.name, "claimed-user");
});

test("useTaskSpace missing returns error object", async () => {
  const { runtime } = setup();
  const result = await runtime.handle("useTaskSpace", { id: 999 });
  assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_FOUND");
  assert.ok(result.error);
});

test("completeTaskSpace keeps tabs under user ownership", async () => {
  const { sm, runtime } = setup();
  const a = sm.createAgentSpace("done");
  sm.use(a.id);
  sm.assignTarget("t-keep");
  await runtime.handle("completeTaskSpace", {});
  assert.equal(sm.list().find((s) => s.id === a.id)?.ownership, "user");
  assert.deepEqual(sm.list().find((s) => s.id === a.id)?.targetIds, ["t-keep"]);
});

test("closeTaskSpace removes agent space and closes targets", async () => {
  const { sm, fakeCdp, runtime } = setup();
  const a = sm.createAgentSpace("close-me");
  sm.use(a.id);
  sm.assignTarget("t-close");
  await runtime.handle("closeTaskSpace", {});
  assert.equal(
    sm.list().find((s) => s.id === a.id),
    undefined,
  );
  assert.deepEqual(fakeCdp.closedTargets, ["t-close"]);
});

test("sendCDPMessage forwards when agent controls space", async () => {
  const { sm, fakeCdp, runtime } = setup();
  const a = sm.createAgentSpace("cdp");
  sm.use(a.id);

  const ack = await runtime.handle("sendCDPMessage", {
    payload: JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "1" },
      sessionId: "s1",
    }),
  });
  assert.deepEqual(ack, { ok: true });
  assert.equal(fakeCdp.rawSent.length, 1);
  assert.equal((fakeCdp.rawSent[0] as any).method, "Runtime.evaluate");
});

test("sendCDPMessage page domain blocked under user control emits cdp.sendError", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(1);

  const events: any[] = [];
  runtime.onEvent((ev) => events.push(ev));

  const ack = await runtime.handle("sendCDPMessage", {
    payload: JSON.stringify({
      id: 2,
      method: "Page.navigate",
      params: { url: "https://evil" },
      sessionId: "s1",
    }),
  });
  assert.deepEqual(ack, { ok: true });
  assert.equal(fakeCdp.rawSent.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "cdp.sendError");
  assert.equal(events[0].params.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
});

test("sendCDPMessage allows only the read-only browser version under user control", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(1);

  await runtime.handle("sendCDPMessage", {
    payload: JSON.stringify({
      id: 3,
      method: "Browser.getVersion",
      params: {},
    }),
  });
  assert.equal(fakeCdp.rawSent.length, 1);
  assert.equal((fakeCdp.rawSent[0] as any).method, "Browser.getVersion");
});

test("sendCDPMessage blocks browser and target mutations without agent ownership", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(1);

  const events: any[] = [];
  runtime.onEvent((ev) => events.push(ev));
  for (const [id, method] of [
    [4, "Target.getTargets"],
    [5, "Target.activateTarget"],
    [6, "Target.createTarget"],
    [7, "Target.closeTarget"],
    [8, "Browser.setDownloadBehavior"],
    [9, "Browser.close"],
  ] as const) {
    await runtime.handle("sendCDPMessage", {
      payload: JSON.stringify({ id, method, params: {} }),
    });
  }

  assert.equal(fakeCdp.rawSent.length, 0);
  assert.equal(events.length, 6);
  assert.ok(
    events.every(
      (event) =>
        event.event === "cdp.sendError" &&
        event.params.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
    ),
  );
});

test("tab operations reject user-owned and handed-off spaces", async () => {
  for (const ownership of ["user", "agentDelegatedToUser"] as const) {
    const { sm, fakeCdp, runtime } = setup({
      targets: [
        {
          targetId: "owned-tab",
          title: "Owned",
          url: "https://owned.example",
          type: "page",
        },
      ],
    });
    const space =
      ownership === "user"
        ? sm.list().find((candidate) => candidate.id === 1)!
        : sm.createAgentSpace("handed-off");
    sm.use(space.id);
    sm.assignTarget("owned-tab", space.id);
    if (ownership === "agentDelegatedToUser") sm.handOff();

    for (const method of ["listTabs", "createTab", "closeTaskSpace"]) {
      await assert.rejects(
        () => runtime.handle(method, { url: "https://new.example" }),
        (err: any) => err.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
        `${method} must honor ${ownership} ownership`,
      );
    }
    assert.equal(fakeCdp.targets.length, 1);
    assert.deepEqual(fakeCdp.closedTargets, []);
    assert.ok(sm.list().some((candidate) => candidate.id === space.id));
  }
});

test("closeSelected rejects a user-owned space before clearing its tabs", () => {
  const sm = new SpaceManager();
  sm.use(1);
  sm.assignTarget("user-tab");

  assert.throws(
    () => sm.closeSelected(),
    (err: any) => err.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  assert.deepEqual(sm.targetsForSelected(), ["user-tab"]);
});

test("attachCdpForwarding pushes cdp.message events", async () => {
  const { fakeCdp, runtime } = setup();
  const events: any[] = [];
  runtime.onEvent((ev) => events.push(ev));
  runtime.attachCdpForwarding();

  fakeCdp.deliverMessage({ method: "Page.loadEventFired", params: {} });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "cdp.message");
  assert.equal(JSON.parse(events[0].params.payload).method, "Page.loadEventFired");
});

test("harness CDP ids never collide with the daemon's own requests", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(sm.createAgentSpace("ids").id);
  const events: any[] = [];
  runtime.onEvent((ev) => events.push(ev));
  runtime.attachCdpForwarding();

  await runtime.handle("sendCDPMessage", {
    payload: JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {} }),
  });
  const sent = fakeCdp.rawSent[0] as { id: number };
  assert.notEqual(sent.id, 1);

  // The daemon's own Target.getTargets reply, id 1: not the harness's business.
  fakeCdp.deliverMessage({ id: 1, result: { targetInfos: [] } });
  assert.equal(events.length, 0);

  // The reply to the harness request comes back under the harness's id.
  fakeCdp.deliverMessage({ id: sent.id, result: { result: { value: 8 } } });
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0].params.payload), {
    id: 1,
    result: { result: { value: 8 } },
  });
});

test("handle accepts ego. prefix methods", async () => {
  const { sm, runtime } = setup();
  const a = sm.createAgentSpace("prefixed");
  sm.use(a.id);
  const result = await runtime.handle("ego.listTabs", {});
  assert.deepEqual(result.tabs, []);
});

test("agent overlay methods evaluate script on the active session", async () => {
  const { sm, fakeCdp, runtime } = setup();
  const space = sm.createAgentSpace("job");
  sm.use(space.id);
  const sent: Array<[string, any, string | undefined]> = [];
  const origSend = fakeCdp.send;
  fakeCdp.send = async (method, params, sessionId) => {
    sent.push([method, params, sessionId]);
    return origSend(method, params, sessionId);
  };

  const r1 = await runtime.handle("animationHighlightMouseToPosition", {
    x: 10,
    y: 20,
  });
  assert.deepEqual(r1, { ok: true });
  const r2 = await runtime.handle("ego.setAgentTaskState", {
    label: "working",
  });
  assert.deepEqual(r2, { ok: true });

  assert.equal(sent.length, 2);
  for (const [method, , sessionId] of sent) {
    assert.equal(method, "Runtime.evaluate");
    assert.equal(sessionId, "sess-1");
  }
  assert.match(sent[0][1].expression, /moveCursor\(10,20\)/);
  assert.match(sent[1][1].expression, /setLabel\("working"\)/);
});

test("agent overlay is a silent no-op under user control or on error", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(1); // user space → page control blocked
  const sent: string[] = [];
  fakeCdp.send = async (method) => {
    sent.push(method);
    return {};
  };
  assert.deepEqual(
    await runtime.handle("animationHighlightMouseToPosition", { x: 1, y: 2 }),
    { ok: true },
  );
  assert.deepEqual(await runtime.handle("setAgentTaskState", { label: "x" }), {
    ok: true,
  });
  assert.equal(sent.length, 0);

  // agent space but ensureSession fails (no tab) → still ok
  const sm2 = new SpaceManager();
  const runtime2 = createEgoRuntime({
    spaceManager: sm2,
    getCdp: () => fakeCdp,
    ensureSession: async () => {
      throw new Error("no tab");
    },
  });
  const space = sm2.createAgentSpace("job");
  sm2.use(space.id);
  assert.deepEqual(
    await runtime2.handle("animationHighlightMouseToPosition", { x: 1, y: 2 }),
    { ok: true },
  );

  // invalid coords → no-op, no throw
  assert.deepEqual(
    await runtime.handle("animationHighlightMouseToPosition", {}),
    { ok: true },
  );
});

test("atividade de pagina marca o overlay; CDP browser-level nao marca", async () => {
  const { sm, fakeCdp, runtime } = setupWithIdle(5000, 60);
  sm.use(sm.createAgentSpace("job").id);
  const evaluates = captureEvaluates(fakeCdp);

  await runtime.handle("snapshot", {});
  await runtime.handle("sendCDPMessage", {
    payload: '{"id":1,"method":"Page.navigate","params":{"url":"about:blank"}}',
  });
  // marcação é fire-and-forget e o rótulo novo espera a retenção
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(labels(evaluates), ["lendo página", "navegando"]);

  // browser-level CDP não é ação de página: não marca
  const before = evaluates.length;
  await runtime.handle("sendCDPMessage", {
    payload: '{"id":2,"method":"Target.getTargets"}',
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(evaluates.length, before);
});

test("actionLabel traduz o metodo CDP para o rotulo do badge", () => {
  assert.equal(actionLabel("Input.dispatchMouseEvent"), "clicando");
  assert.equal(actionLabel("Input.dispatchKeyEvent"), "digitando");
  assert.equal(actionLabel("Input.insertText"), "digitando");
  assert.equal(actionLabel("Page.navigate"), "navegando");
  assert.equal(actionLabel("Page.reload"), "navegando");
  assert.equal(actionLabel("Page.captureScreenshot"), "capturando");
  assert.equal(actionLabel("Runtime.evaluate"), "lendo página");
  assert.equal(actionLabel("Accessibility.getFullAXTree"), "lendo página");
  assert.equal(actionLabel("Storage.clearDataForOrigin"), "trabalhando");
});

/** Coleta as expressões injetadas pelo overlay. */
function captureEvaluates(fakeCdp: any): string[] {
  const evaluates: string[] = [];
  const orig = fakeCdp.send;
  fakeCdp.send = async (method: string, params: any, sessionId?: string) => {
    if (method === "Runtime.evaluate") evaluates.push(params.expression);
    return orig(method, params, sessionId);
  };
  return evaluates;
}

test("atividade marca o overlay como ativo com o rotulo da acao", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(sm.createAgentSpace("job").id);
  const evaluates = captureEvaluates(fakeCdp);

  await runtime.handle("sendCDPMessage", {
    payload: '{"id":1,"method":"Input.dispatchMouseEvent","params":{}}',
  });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(evaluates.length, 1);
  assert.match(evaluates[0], /setState\("active","clicando"\)/);
});

test("acao repetida nao repinta o badge", async () => {
  const { sm, fakeCdp, runtime } = setupWithIdle(5000, 60);
  sm.use(sm.createAgentSpace("job").id);
  const evaluates = captureEvaluates(fakeCdp);

  const click = '{"id":1,"method":"Input.dispatchMouseEvent","params":{}}';
  await runtime.handle("sendCDPMessage", { payload: click });
  await runtime.handle("sendCDPMessage", { payload: click });
  await new Promise((r) => setTimeout(r, 120));

  assert.deepEqual(labels(evaluates), ["clicando"]);
});

const CLICK = '{"id":1,"method":"Input.dispatchMouseEvent","params":{}}';
const NAV = '{"id":2,"method":"Page.navigate","params":{"url":"about:blank"}}';
const TYPE = '{"id":3,"method":"Input.insertText","params":{"text":"x"}}';

/** Rótulos efetivamente pintados, na ordem. */
function labels(evaluates: string[]): string[] {
  return evaluates
    .map((e) => e.match(/setState\("active","([^"]+)"\)/)?.[1])
    .filter((x): x is string => Boolean(x));
}

test("rotulo novo dentro da retencao espera a vez, em vez de piscar", async () => {
  const { sm, fakeCdp, runtime } = setupWithIdle(5000, 120);
  sm.use(sm.createAgentSpace("job").id);
  const evaluates = captureEvaluates(fakeCdp);

  await runtime.handle("sendCDPMessage", { payload: CLICK });
  await runtime.handle("sendCDPMessage", { payload: NAV });
  await new Promise((r) => setTimeout(r, 20));
  // a segunda ação não pode atropelar a primeira antes da retenção
  assert.deepEqual(labels(evaluates), ["clicando"]);

  await new Promise((r) => setTimeout(r, 160));
  assert.deepEqual(labels(evaluates), ["clicando", "navegando"]);
});

test("na rajada vale o ultimo rotulo; os intermediarios sao descartados", async () => {
  const { sm, fakeCdp, runtime } = setupWithIdle(5000, 120);
  sm.use(sm.createAgentSpace("job").id);
  const evaluates = captureEvaluates(fakeCdp);

  await runtime.handle("sendCDPMessage", { payload: CLICK });
  await runtime.handle("sendCDPMessage", { payload: NAV });
  await runtime.handle("sendCDPMessage", { payload: TYPE });
  await new Promise((r) => setTimeout(r, 200));

  // "navegando" existiu por milissegundos: mostrá-lo seria ruído ilegível
  assert.deepEqual(labels(evaluates), ["clicando", "digitando"]);
});

test("rajada que termina no rotulo ja exibido nao repinta", async () => {
  const { sm, fakeCdp, runtime } = setupWithIdle(5000, 120);
  sm.use(sm.createAgentSpace("job").id);
  const evaluates = captureEvaluates(fakeCdp);

  await runtime.handle("sendCDPMessage", { payload: CLICK });
  await runtime.handle("sendCDPMessage", { payload: NAV });
  await runtime.handle("sendCDPMessage", { payload: CLICK });
  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(labels(evaluates), ["clicando"]);
});

const READ = '{"id":4,"method":"Runtime.evaluate","params":{}}';

test("acao real atropela a leitura generica mesmo dentro da retencao", async () => {
  const { sm, fakeCdp, runtime } = setupWithIdle(5000, 400);
  sm.use(sm.createAgentSpace("job").id);
  const evaluates = captureEvaluates(fakeCdp);

  // é o que o harness faz num fill: resolve o seletor, digita, lê de volta
  await runtime.handle("sendCDPMessage", { payload: READ });
  await runtime.handle("sendCDPMessage", { payload: TYPE });
  await new Promise((r) => setTimeout(r, 30));

  // sem isto o badge fica preso em "lendo página" durante o fill inteiro
  assert.deepEqual(labels(evaluates), ["lendo página", "digitando"]);
});

test("leitura generica nao desbanca uma acao real ja na fila", async () => {
  const { sm, fakeCdp, runtime } = setupWithIdle(5000, 200);
  sm.use(sm.createAgentSpace("job").id);
  const evaluates = captureEvaluates(fakeCdp);

  await runtime.handle("sendCDPMessage", { payload: CLICK });
  await runtime.handle("sendCDPMessage", { payload: NAV }); // fica na fila
  await runtime.handle("sendCDPMessage", { payload: READ }); // não pode roubar a vez
  await new Promise((r) => setTimeout(r, 300));

  assert.deepEqual(labels(evaluates), ["clicando", "navegando"]);
});

test("sem atividade, o overlay cai para o estado parado", async () => {
  const { sm, fakeCdp, runtime } = setupWithIdle(25);
  sm.use(sm.createAgentSpace("job").id);
  const evaluates = captureEvaluates(fakeCdp);

  await runtime.handle("sendCDPMessage", {
    payload: '{"id":1,"method":"Page.navigate","params":{"url":"about:blank"}}',
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    evaluates.filter((e) => e.includes('setState("idle"')).length,
    0,
  );

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(
    evaluates.filter((e) => e.includes('setState("idle"')).length,
    1,
  );
});

test("Target.activateTarget makes that tab active for listTabs and snapshot across rounds", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(sm.createAgentSpace("a2").id);
  const { targetId: first } = await runtime.handle("createTab", {
    url: "https://example.com",
  });
  await runtime.handle("createTab", { url: "https://en.wikipedia.org" });
  // The harness's switchTab sends this raw; the host must remember it.
  await runtime.handle("sendCDPMessage", {
    payload: JSON.stringify({
      id: 7,
      method: "Target.activateTarget",
      params: { targetId: first },
    }),
  });

  const { tabs } = await runtime.handle("listTabs", {});
  assert.deepEqual(
    tabs.map((t: { targetId: string; active: boolean }) => [t.targetId, t.active]),
    [[first, true], ["T2", false]],
  );

  // snapshot attaches to the same tab, not to the last one Chrome lists.
  const sessions: unknown[] = [];
  const send = fakeCdp.send;
  fakeCdp.send = async (method, params, sessionId) => {
    if (method === "Accessibility.getFullAXTree") sessions.push(sessionId);
    return send(method, params, sessionId);
  };
  await runtime.handle("snapshot", {});
  assert.deepEqual(sessions, [`session-${first}`]);

  // Selection survives the tab list order and a daemon restart via persistence.
  sm.reconcileTargets(["T2"]);
  assert.equal(sm.activeTargetForSelected(), "T2");
});
