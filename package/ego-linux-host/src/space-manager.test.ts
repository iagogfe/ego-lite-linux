import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpaceManager } from "./space-manager.js";

test("bootstraps user space id 1", () => {
  const sm = new SpaceManager();
  const user = sm.list().find((s) => s.id === 1);
  assert.equal(user?.ownership, "user");
  assert.equal(user?.name, "user");
});

test("createAgentSpace assigns tabs independently", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("job-a");
  const b = sm.createAgentSpace("job-b");
  sm.use(a.id);
  sm.assignTarget("t1");
  sm.use(b.id);
  sm.assignTarget("t2");
  sm.use(a.id);
  assert.deepEqual(sm.targetsForSelected(), ["t1"]);
  sm.use(b.id);
  assert.deepEqual(sm.targetsForSelected(), ["t2"]);
});

test("use on user space selects but marks user control for page ops", () => {
  const sm = new SpaceManager();
  const result = sm.use(1);
  assert.equal(result.ok, true);
  assert.equal(sm.selected()?.ownership, "user");
  assert.equal(sm.isPageControlBlocked(), true);
});

test("handOff then takeOver", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("x");
  sm.use(a.id);
  sm.handOff();
  assert.equal(sm.selected()?.ownership, "agentDelegatedToUser");
  assert.equal(sm.isPageControlBlocked(), true);
  sm.takeOver();
  assert.equal(sm.selected()?.ownership, "agent");
  assert.equal(sm.isPageControlBlocked(), false);
});

test("claim moves user space to agent", () => {
  const sm = new SpaceManager();
  sm.claim(1);
  assert.equal(sm.list().find((s) => s.id === 1)?.ownership, "agent");
});

test("use missing space returns not found", () => {
  const sm = new SpaceManager();
  const result = sm.use(999);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_FOUND");
  }
});

test("isPageControlBlocked false only for agent ownership", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("agent-job");
  sm.use(a.id);
  assert.equal(sm.selected()?.ownership, "agent");
  assert.equal(sm.isPageControlBlocked(), false);
});

test("listPublic strips targetIds", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("pub");
  sm.use(a.id);
  sm.assignTarget("t-pub");
  const pub = sm.listPublic().find((s) => s.id === a.id);
  assert.ok(pub);
  assert.equal("targetIds" in (pub as object), false);
  assert.equal(pub?.name, "pub");
  const internal = sm.list().find((s) => s.id === a.id);
  assert.deepEqual(internal?.targetIds, ["t-pub"]);
});

test("assignTarget moves tab between spaces", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("a");
  const b = sm.createAgentSpace("b");
  sm.assignTarget("shared", a.id);
  assert.equal(sm.spaceIdForTarget("shared"), a.id);
  sm.assignTarget("shared", b.id);
  assert.equal(sm.spaceIdForTarget("shared"), b.id);
  assert.equal(
    sm
      .list()
      .find((s) => s.id === a.id)
      ?.targetIds.includes("shared"),
    false,
  );
});

test("reconcileTargets removes memberships for closed Chrome targets", () => {
  const sm = new SpaceManager();
  const agent = sm.createAgentSpace("stale");
  sm.assignTarget("live", agent.id);
  sm.assignTarget("closed", agent.id);

  sm.reconcileTargets(["live"]);

  assert.deepEqual(sm.list().find((s) => s.id === agent.id)?.targetIds, [
    "live",
  ]);
});

test("selection is per client and does not leak between them", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("client-a");
  const b = sm.createAgentSpace("client-b");

  sm.runForClient("A", () => sm.use(a.id));
  sm.runForClient("B", () => sm.use(b.id));
  // A selected first, B second: with one shared cursor A's tab lands in B.
  sm.runForClient("A", () => sm.assignTarget("ta"));
  sm.runForClient("B", () => sm.assignTarget("tb"));

  assert.equal(sm.spaceIdForTarget("ta"), a.id);
  assert.equal(sm.spaceIdForTarget("tb"), b.id);
  assert.equal(
    sm.runForClient("A", () => sm.selected()?.id),
    a.id,
  );
  assert.deepEqual(
    sm.runForClient("A", () => sm.targetsForSelected()),
    ["ta"],
  );
  // A client that never selected sees no space, it does not inherit one.
  assert.equal(
    sm.runForClient("C", () => sm.selected()),
    null,
  );
});

test("releaseClient drops a disconnected client's selection", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("gone");
  sm.runForClient("A", () => sm.use(a.id));
  sm.releaseClient("A");
  assert.equal(
    sm.runForClient("A", () => sm.selected()),
    null,
  );
});

test("pruneEmptyAgentSpaces drops tabless agent spaces and keeps the rest", () => {
  const sm = new SpaceManager();
  const empty = sm.createAgentSpace("empty");
  const busy = sm.createAgentSpace("busy");
  sm.assignTarget("t1", busy.id);
  const handedOff = sm.createAgentSpace("handed-off");
  sm.use(handedOff.id);
  sm.handOff();
  // A space a live client just created and has not filled yet must survive.
  const justCreated = sm.createAgentSpace("just-created");
  sm.runForClient("live", () => sm.use(justCreated.id));

  assert.equal(sm.pruneEmptyAgentSpaces(), 1);

  const ids = sm.list().map((s) => s.id);
  assert.equal(ids.includes(empty.id), false, "empty agent space is dropped");
  assert.ok(ids.includes(busy.id), "space with a tab survives");
  assert.ok(ids.includes(1), "user space survives");
  assert.ok(
    ids.includes(handedOff.id),
    "a space under user control is not agent-owned garbage",
  );
  assert.ok(
    ids.includes(justCreated.id),
    "a space a live client selected is not garbage yet",
  );
});

test("collectStaleAgentSpaces closes only abandoned agent tabs", () => {
  const sm = new SpaceManager();
  const HOUR = 60 * 60 * 1000;
  const now = Date.now();

  const stale = sm.createAgentSpace("stale-agent");
  sm.assignTarget("stale-tab", stale.id);
  const fresh = sm.createAgentSpace("fresh-agent");
  sm.assignTarget("fresh-tab", fresh.id);
  const delegated = sm.createAgentSpace("delegated");
  sm.use(delegated.id);
  sm.assignTarget("delegated-tab");
  sm.handOff();
  const selected = sm.createAgentSpace("in-use");
  sm.assignTarget("in-use-tab", selected.id);
  // The person's own tab lives in the user space.
  sm.assignTarget("user-tab", 1);

  // Age everything except the fresh space, then hold one via a live client.
  for (const space of [stale, delegated, selected]) {
    (sm as any).spaces.find((s: any) => s.id === space.id).lastUsedAt =
      now - 3 * HOUR;
  }
  (sm as any).spaces.find((s: any) => s.id === 1).lastUsedAt = now - 3 * HOUR;
  sm.runForClient("live", () => sm.use(selected.id));
  (sm as any).spaces.find((s: any) => s.id === selected.id).lastUsedAt =
    now - 3 * HOUR;

  const closed = sm.collectStaleAgentSpaces(2 * HOUR, now);

  assert.deepEqual(closed, ["stale-tab"]);
  const ids = sm.list().map((s) => s.id);
  assert.equal(ids.includes(stale.id), false);
  assert.ok(ids.includes(fresh.id), "recently used agent space survives");
  assert.ok(ids.includes(delegated.id), "user was handed control; not garbage");
  assert.ok(ids.includes(selected.id), "a live client has it selected");
  assert.ok(ids.includes(1), "the user space is never collected");
  assert.equal(
    sm.spaceIdForTarget("user-tab"),
    1,
    "the person's own tab is never closed",
  );
});

test("clearSelection leaves persisted spaces available without selecting one", () => {
  const sm = new SpaceManager();
  const agent = sm.createAgentSpace("resume-by-name");
  sm.use(agent.id);
  sm.clearSelection();

  assert.equal(sm.selected(), null);
  assert.ok(sm.list().some((space) => space.id === agent.id));
});

test("adoptOrphanTargets puts unknowns on user space", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("known");
  sm.assignTarget("known-t", a.id);
  sm.adoptOrphanTargets(["known-t", "orphan-1", "orphan-2"]);
  assert.equal(sm.spaceIdForTarget("known-t"), a.id);
  assert.equal(sm.spaceIdForTarget("orphan-1"), 1);
  assert.equal(sm.spaceIdForTarget("orphan-2"), 1);
});

test("closeSelected returns targetIds and removes agent space", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("to-close");
  sm.use(a.id);
  sm.assignTarget("c1");
  sm.assignTarget("c2");
  const closed = sm.closeSelected();
  assert.deepEqual(closed.sort(), ["c1", "c2"]);
  assert.equal(
    sm.list().find((s) => s.id === a.id),
    undefined,
  );
  assert.equal(sm.selected(), null);
});

test("completeKeep transfers selected agent space to user ownership", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("done-keep");
  sm.use(a.id);
  sm.assignTarget("keep-tab");
  sm.completeKeep();
  const space = sm.list().find((s) => s.id === a.id);
  assert.equal(space?.ownership, "user");
  assert.deepEqual(space?.targetIds, ["keep-tab"]);
});

test("claim selects space and can rename", () => {
  const sm = new SpaceManager();
  const claimed = sm.claim(1, "claimed-user");
  assert.equal(claimed.ownership, "agent");
  assert.equal(claimed.name, "claimed-user");
  assert.equal(sm.selected()?.id, 1);
  assert.equal(sm.isPageControlBlocked(), false);
});

test("save cria o diretorio com 0700", async () => {
  const dir = join(
    tmpdir(),
    `ego-spaces-mode-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const sm = new SpaceManager(join(dir, "sub", "spaces.json"));
  try {
    await sm.load();
    await sm.save();
    const { mode } = await stat(join(dir, "sub"));
    // spaces.json lista os tabsets do usuario; diretorio legivel por outros
    // usuarios da maquina seria vazamento de contexto de navegacao
    assert.equal(mode & 0o777, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persist save/load round-trips spaces and selection", async () => {
  const dir = join(tmpdir(), `ego-space-mgr-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "spaces.json");
  try {
    const sm = new SpaceManager(path);
    const a = sm.createAgentSpace("persisted");
    sm.use(a.id);
    sm.assignTarget("pt1");
    sm.assignTarget("pt2");
    sm.activateTarget("pt1");
    sm.handOff();
    await sm.save();

    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(typeof raw.nextId, "number");
    assert.equal(raw.selectedId, a.id);
    assert.ok(Array.isArray(raw.spaces));

    const sm2 = new SpaceManager(path);
    await sm2.load();
    assert.equal(sm2.selected()?.id, a.id);
    assert.equal(sm2.selected()?.ownership, "agentDelegatedToUser");
    assert.deepEqual(sm2.targetsForSelected(), ["pt1", "pt2"]);
    assert.equal(sm2.activeTargetForSelected(), "pt1");
    assert.ok(sm2.list().find((s) => s.id === 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load missing file keeps bootstrap user space", async () => {
  const path = join(
    tmpdir(),
    `ego-space-missing-${process.pid}-${Date.now()}.json`,
  );
  const sm = new SpaceManager(path);
  await sm.load();
  assert.equal(sm.list().find((s) => s.id === 1)?.name, "user");
});

test("load recovers corrupt file to bootstrap", async () => {
  const dir = join(tmpdir(), `ego-space-bad-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "spaces.json");
  try {
    await writeFile(path, "not-json{{{", "utf8");
    const sm = new SpaceManager(path);
    await sm.load();
    assert.equal(sm.list().find((s) => s.id === 1)?.ownership, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
