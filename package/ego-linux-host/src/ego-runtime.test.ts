import test from "node:test";
import assert from "node:assert/strict";
import type { CdpBridge, CdpPageTarget } from "./cdp-bridge.js";
import { actionLabel, createEgoRuntime } from "./ego-runtime.js";
import { SpaceManager } from "./space-manager.js";

type FakeCdp = CdpBridge & {
  targets: CdpPageTarget[];
  rawSent: object[];
  closedTargets: string[];
  messageHandlers: Set<(msg: any) => void>;
  eventHandlers: Set<(msg: any) => void>;
  deliverMessage(msg: any): void;
};

function makeFakeCdp(initial: CdpPageTarget[] = []): FakeCdp {
  let nextTarget = 1;
  const fake: FakeCdp = {
    targets: [...initial],
    rawSent: [],
    closedTargets: [],
    messageHandlers: new Set(),
    eventHandlers: new Set(),
    deliverMessage(msg: any) {
      for (const h of fake.messageHandlers) h(msg);
      if (msg && typeof msg.method === "string") {
        for (const h of fake.eventHandlers) h(msg);
      }
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
    onEvent(handler) {
      fake.eventHandlers.add(handler);
      return () => fake.eventHandlers.delete(handler);
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
      { targetId: "user-tab", title: "User", url: "https://u.example", type: "page" },
      { targetId: "agent-tab", title: "Agent", url: "https://a.example", type: "page" },
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

test("createTab fails without selected space", async () => {
  const { runtime } = setup();
  await assert.rejects(
    () => runtime.handle("createTab", { url: "https://x" }),
    (err: any) => err.error_code === "EGO_TASK_SPACE_NOT_SELECTED",
  );
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

test("sendCDPMessage allows Target.* under user control", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(1);

  await runtime.handle("sendCDPMessage", {
    payload: JSON.stringify({
      id: 3,
      method: "Target.getTargets",
      params: {},
    }),
  });
  assert.equal(fakeCdp.rawSent.length, 1);
  assert.equal((fakeCdp.rawSent[0] as any).method, "Target.getTargets");
});

test("attachCdpForwarding pushes cdp.message events", async () => {
  const { fakeCdp, runtime } = setup();
  const events: any[] = [];
  runtime.onEvent((ev) => events.push(ev));
  runtime.attachCdpForwarding();

  fakeCdp.deliverMessage({ id: 9, result: { value: 1 } });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "cdp.message");
  assert.equal(
    JSON.parse(events[0].params.payload).result.value,
    1,
  );
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
  assert.equal(evaluates.filter((e) => e.includes('setState("idle"')).length, 0);

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(evaluates.filter((e) => e.includes('setState("idle"')).length, 1);
});
