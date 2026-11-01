import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createViewerCooldown } from "./viewer-cooldown.js";

/** Two tabs in window 1, one tab in window 2; windows keep their own state. */
function fakeBrowser(
  initial: Record<number, string> = { 1: "maximized", 2: "normal" },
) {
  const states = new Map<number, string>(
    Object.entries(initial).map(([id, s]) => [Number(id), s]),
  );
  const tabs: Record<string, number> = { a: 1, b: 1, c: 2 };
  const sets: { windowId: number; windowState: string }[] = [];
  const cdp = {
    async listPageTargets() {
      return Object.keys(tabs).map((targetId) => ({
        targetId,
        title: "",
        url: "",
        type: "page",
      }));
    },
    async send(method: string, params: any) {
      if (method === "Browser.getWindowForTarget") {
        return { windowId: tabs[params.targetId] };
      }
      if (method === "Browser.getWindowBounds") {
        return { bounds: { windowState: states.get(params.windowId) } };
      }
      if (method === "Browser.setWindowBounds") {
        states.set(params.windowId, params.bounds.windowState);
        sets.push({
          windowId: params.windowId,
          windowState: params.bounds.windowState,
        });
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { cdp, states, sets };
}

test("nothing is minimized while the viewer is present", async () => {
  const { cdp, sets } = fakeBrowser();
  const cd = createViewerCooldown({ getCdp: () => cdp, idleMs: 10 });
  await cd.beginCall();
  cd.endCall();
  await delay(40);
  assert.deepEqual(
    sets,
    [],
    "a host without the viewer hook must behave as before",
  );
  cd.dispose();
});

test("viewer away + idle minimizes each window once, present restores its state", async () => {
  const { cdp, states } = fakeBrowser();
  const cd = createViewerCooldown({ getCdp: () => cdp, idleMs: 10 });
  await cd.setViewer(false);
  await delay(40);
  assert.equal(states.get(1), "minimized");
  assert.equal(states.get(2), "minimized");
  assert.deepEqual(cd.status(), { viewer: "away", cooled: true });

  await cd.setViewer(true);
  // Not "normal": the window started maximized and must come back maximized.
  assert.equal(states.get(1), "maximized");
  assert.equal(states.get(2), "normal");
  assert.deepEqual(cd.status(), { viewer: "present", cooled: false });
  cd.dispose();
});

test("an agent call restores the windows before it runs and re-cools after idle", async () => {
  const { cdp, states } = fakeBrowser();
  const cd = createViewerCooldown({ getCdp: () => cdp, idleMs: 10 });
  await cd.setViewer(false);
  await delay(40);
  assert.equal(states.get(1), "minimized");

  // Hidden pages drop wheel input and never fire rAF: the call needs them up.
  await cd.beginCall();
  assert.equal(states.get(1), "maximized");
  await delay(40);
  assert.equal(
    states.get(1),
    "maximized",
    "no cooldown while a call is in flight",
  );

  cd.endCall();
  await delay(40);
  assert.equal(
    states.get(1),
    "minimized",
    "cools again once the agents are idle",
  );
  cd.dispose();
});

test("a window already left minimized comes back on present and before agent calls", async () => {
  // E.g. a restore that did not take, or a daemon that lost its record.
  const { cdp, states } = fakeBrowser({ 1: "minimized", 2: "normal" });
  const cd = createViewerCooldown({ getCdp: () => cdp, idleMs: 10 });
  await cd.setViewer(true);
  assert.equal(states.get(1), "normal", "present sweeps every window");

  states.set(1, "minimized");
  await cd.setViewer(false);
  await delay(40);
  await cd.beginCall();
  assert.equal(states.get(1), "normal");
  assert.equal(states.get(2), "normal");
  cd.endCall();
  cd.dispose();
});

test("a restarted host still restores the windows the previous one cooled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-cooldown-"));
  try {
    const statePath = join(dir, "viewer-cooldown.json");
    const { cdp, states } = fakeBrowser();
    const first = createViewerCooldown({
      getCdp: () => cdp,
      idleMs: 10,
      statePath,
    });
    await first.setViewer(false);
    await delay(40);
    assert.equal(states.get(1), "minimized");
    first.dispose();

    // The daemon died while cooled; the next one starts with viewer present.
    const second = createViewerCooldown({
      getCdp: () => cdp,
      idleMs: 10,
      statePath,
    });
    assert.equal(second.status().cooled, true);
    await second.setViewer(true);
    assert.equal(states.get(1), "maximized");
    assert.equal(states.get(2), "normal");
    assert.equal(existsSync(statePath), false, "nothing left to restore");
    second.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an open agent connection holds the cooldown until it closes", async () => {
  const { cdp, states } = fakeBrowser();
  let open = true;
  const cd = createViewerCooldown({
    getCdp: () => cdp,
    idleMs: 10,
    hasClients: () => open,
  });
  await cd.setViewer(false);
  await cd.beginCall();
  cd.endCall();
  // A heredoc sleeping between calls still holds its socket.
  await delay(40);
  assert.equal(states.get(1), "maximized");

  open = false;
  cd.clientClosed();
  await delay(40);
  assert.equal(states.get(1), "minimized");
  cd.dispose();
});
