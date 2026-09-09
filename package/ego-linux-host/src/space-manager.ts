import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { makeEgoError } from "./errors.js";

/**
 * Which client's selection the current call sees. The daemon runs every RPC
 * inside `runForClient`, so concurrent `ego-browser` processes never read each
 * other's cursor. Outside any client (startup, tests) the manager falls back to
 * a single process-wide selection.
 */
const clientScope = new AsyncLocalStorage<string>();

/** Id of the connection whose RPC is running, when there is one. */
export function currentClientId(): string | undefined {
  return clientScope.getStore();
}

export type Ownership = "agent" | "agentDelegatedToUser" | "user";

export type Space = {
  taskId: string;
  id: number;
  name: string;
  createdBy: "agent" | "user";
  ownership: Ownership;
  recentTabTitles?: string[];
  targetIds: string[];
  /** Tab the agent last created/activated here; survives across heredoc rounds. */
  activeTargetId?: string;
  /** Last time an agent selected this space or moved a tab into it. */
  lastUsedAt?: number;
};

export type UseResult =
  | { ok: true; space: Space }
  | { ok: false; error_code: string; error: string };

type PersistShape = {
  nextId: number;
  selectedId: number | null;
  spaces: Space[];
};

const USER_SPACE_ID = 1;

function bootstrapUserSpace(): Space {
  return {
    taskId: "user",
    id: USER_SPACE_ID,
    name: "user",
    createdBy: "user",
    ownership: "user",
    targetIds: [],
  };
}

function cloneSpace(space: Space): Space {
  return {
    ...space,
    targetIds: [...space.targetIds],
    ...(space.recentTabTitles
      ? { recentTabTitles: [...space.recentTabTitles] }
      : {}),
  };
}

/**
 * Task Spaces = named tab sets + ownership in one shared Chromium profile.
 * Isolation is tabs/control, not cookies.
 */
export class SpaceManager {
  private readonly persistPath: string | undefined;
  private nextId = USER_SPACE_ID + 1;
  /** Selection outside any client scope (startup, direct use in tests). */
  private selectedId: number | null = null;
  private readonly selections = new Map<string, number>();
  private spaces: Space[] = [bootstrapUserSpace()];

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
  }

  /**
   * Run `fn` with the task-space selection scoped to `clientId`.
   * A client that never selected sees no space: inheriting another client's
   * selection is what let one agent's tab land in another agent's space.
   */
  runForClient<T>(clientId: string, fn: () => T): T {
    return clientScope.run(clientId, fn);
  }

  /** Drop a disconnected client's selection so the map cannot grow forever. */
  releaseClient(clientId: string): void {
    this.selections.delete(clientId);
  }

  private currentSelection(): number | null {
    const clientId = clientScope.getStore();
    if (clientId === undefined) return this.selectedId;
    return this.selections.get(clientId) ?? null;
  }

  private setSelection(id: number | null): void {
    const clientId = clientScope.getStore();
    if (clientId === undefined) {
      this.selectedId = id;
      return;
    }
    if (id === null) this.selections.delete(clientId);
    else this.selections.set(clientId, id);
  }

  async load(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as PersistShape;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.spaces)
      ) {
        this.resetBootstrap();
        return;
      }
      const spaces: Space[] = [];
      for (const entry of parsed.spaces) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.id !== "number" || typeof entry.name !== "string") {
          continue;
        }
        const ownership = entry.ownership;
        if (
          ownership !== "agent" &&
          ownership !== "agentDelegatedToUser" &&
          ownership !== "user"
        ) {
          continue;
        }
        const createdBy =
          entry.createdBy === "agent" || entry.createdBy === "user"
            ? entry.createdBy
            : ownership === "user"
              ? "user"
              : "agent";
        spaces.push({
          taskId:
            typeof entry.taskId === "string" ? entry.taskId : String(entry.id),
          id: entry.id,
          name: entry.name,
          createdBy,
          ownership,
          targetIds: Array.isArray(entry.targetIds)
            ? entry.targetIds.filter((t): t is string => typeof t === "string")
            : [],
          ...(typeof entry.activeTargetId === "string"
            ? { activeTargetId: entry.activeTargetId }
            : {}),
          ...(typeof entry.lastUsedAt === "number"
            ? { lastUsedAt: entry.lastUsedAt }
            : {}),
          ...(Array.isArray(entry.recentTabTitles)
            ? {
                recentTabTitles: entry.recentTabTitles.filter(
                  (t): t is string => typeof t === "string",
                ),
              }
            : {}),
        });
      }
      if (!spaces.some((s) => s.id === USER_SPACE_ID)) {
        spaces.unshift(bootstrapUserSpace());
      }
      this.spaces = spaces;
      this.nextId =
        typeof parsed.nextId === "number" && parsed.nextId > USER_SPACE_ID
          ? parsed.nextId
          : Math.max(USER_SPACE_ID + 1, ...spaces.map((s) => s.id + 1));
      if (
        parsed.selectedId === null ||
        parsed.selectedId === undefined ||
        typeof parsed.selectedId !== "number"
      ) {
        this.selectedId = null;
      } else if (this.findSpace(parsed.selectedId)) {
        this.selectedId = parsed.selectedId;
      } else {
        this.selectedId = null;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.resetBootstrap();
        return;
      }
      // Corrupt JSON or unexpected shape → bootstrap
      this.resetBootstrap();
    }
  }

  async save(): Promise<void> {
    if (!this.persistPath) return;
    const payload: PersistShape = {
      nextId: this.nextId,
      selectedId: this.selectedId,
      spaces: this.spaces.map(cloneSpace),
    };
    // 0700 como o daemon faz no dataDir: spaces.json guarda os tabsets do
    // usuario, e quem criar o diretorio primeiro nao pode deixa-lo mais aberto.
    await mkdir(dirname(this.persistPath), { recursive: true, mode: 0o700 });
    await writeFile(this.persistPath, JSON.stringify(payload, null, 2), "utf8");
  }

  /** Do not carry the last daemon selection into a new browser session. */
  clearSelection(): void {
    this.selectedId = null;
    this.selections.clear();
  }

  /** Internal list including targetIds. */
  list(): Space[] {
    return this.spaces.map(cloneSpace);
  }

  /**
   * Drop agent-owned spaces that hold no tab. Returns how many were removed.
   * `minAgeMs` protects spaces touched recently, for callers that run while
   * other clients are mid-creation.
   * Run after reconcileTargets on startup: a space whose tabs are all gone has
   * no work left to preserve, and without this the file grows without bound
   * (measured: 77 of 84 spaces empty). User-owned spaces are never touched.
   */
  pruneEmptyAgentSpaces(minAgeMs = 0, now = Date.now()): number {
    const inUse = new Set(this.selections.values());
    if (this.selectedId !== null) inUse.add(this.selectedId);
    const before = this.spaces.length;
    this.spaces = this.spaces.filter(
      (s) =>
        s.ownership !== "agent" ||
        s.targetIds.length > 0 ||
        inUse.has(s.id) ||
        // A space is created before it is selected or filled: pruning inside
        // that window deletes another client's space out from under it.
        now - (s.lastUsedAt ?? 0) < minAgeMs,
    );
    const removed = before - this.spaces.length;
    if (removed > 0) {
      const live = new Set(this.spaces.map((s) => s.id));
      if (this.selectedId !== null && !live.has(this.selectedId)) {
        this.selectedId = null;
      }
      for (const [clientId, id] of this.selections) {
        if (!live.has(id)) this.selections.delete(clientId);
      }
    }
    return removed;
  }

  /**
   * Agent spaces nobody has touched for `maxAgeMs`. Removes them and returns
   * the tabs the caller should close in Chrome.
   *
   * Nothing else is collected, and the exclusions are the point: a space a
   * live client has selected is in use, a `user` space holds the person's own
   * tabs, and `agentDelegatedToUser` means the person was handed control.
   * Closing a tab is irreversible, so anything ambiguous is left alone.
   */
  collectStaleAgentSpaces(maxAgeMs: number, now = Date.now()): string[] {
    const inUse = new Set(this.selections.values());
    if (this.selectedId !== null) inUse.add(this.selectedId);
    const stale = this.spaces.filter(
      (s) =>
        s.ownership === "agent" &&
        !inUse.has(s.id) &&
        now - (s.lastUsedAt ?? 0) > maxAgeMs,
    );
    if (stale.length === 0) return [];
    const staleIds = new Set(stale.map((s) => s.id));
    this.spaces = this.spaces.filter((s) => !staleIds.has(s.id));
    return stale.flatMap((s) => s.targetIds);
  }

  /** Public records without targetIds (ego listTaskSpaces shape). */
  listPublic(): Array<
    Omit<Space, "targetIds"> & { recentTabTitles?: string[] }
  > {
    return this.spaces.map((s) => {
      const { targetIds: _t, ...rest } = s;
      return {
        ...rest,
        ...(s.recentTabTitles
          ? { recentTabTitles: [...s.recentTabTitles] }
          : {}),
      };
    });
  }

  createAgentSpace(name: string): Space {
    const id = this.nextId++;
    const space: Space = {
      taskId: String(id),
      id,
      name,
      createdBy: "agent",
      ownership: "agent",
      targetIds: [],
      lastUsedAt: Date.now(),
    };
    this.spaces.push(space);
    return cloneSpace(space);
  }

  use(id: number): UseResult {
    const space = this.findSpace(id);
    if (!space) {
      return {
        ok: false,
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
        error: `task space not found: ${id}`,
      };
    }
    space.lastUsedAt = Date.now();
    this.setSelection(id);
    return { ok: true, space: cloneSpace(space) };
  }

  claim(id: number, name?: string): Space {
    const space = this.findSpace(id);
    if (!space) {
      throw Object.assign(new Error(`task space not found: ${id}`), {
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      });
    }
    space.ownership = "agent";
    if (name !== undefined && name !== "") {
      space.name = name;
    }
    space.lastUsedAt = Date.now();
    this.setSelection(id);
    return cloneSpace(space);
  }

  handOff(): void {
    const space = this.selectedSpace();
    if (!space) return;
    if (space.ownership === "agent") {
      space.ownership = "agentDelegatedToUser";
    }
  }

  takeOver(): void {
    const space = this.selectedSpace();
    if (!space) return;
    if (space.ownership === "agentDelegatedToUser") {
      space.ownership = "agent";
    }
  }

  /**
   * Complete selected agent space but keep its tabs: ownership becomes user.
   */
  completeKeep(): void {
    const space = this.selectedSpace();
    if (!space) return;
    if (space.id === USER_SPACE_ID && space.createdBy === "user") {
      // Bootstrap user space stays user-owned; nothing to complete.
      space.ownership = "user";
      return;
    }
    space.ownership = "user";
  }

  /**
   * Close the selected space. Returns targetIds the host should close in Chrome.
   * Requires agent ownership. If the bootstrap user space was explicitly
   * claimed, it clears its tabs without removing the space.
   */
  closeSelected(): string[] {
    if (this.currentSelection() === null) return [];
    const selected = this.requireAgentControl();
    const space = this.findSpace(selected.id)!;
    const targetIds = [...space.targetIds];
    if (space.id === USER_SPACE_ID) {
      space.targetIds = [];
      delete space.activeTargetId;
      space.ownership = "user";
      this.setSelection(null);
      return targetIds;
    }
    this.spaces = this.spaces.filter((s) => s.id !== space.id);
    this.setSelection(null);
    return targetIds;
  }

  selected(): Space | null {
    const space = this.selectedSpace();
    return space ? cloneSpace(space) : null;
  }

  /**
   * Return the selected space only when the agent currently owns its control.
   * All agent tab/page mutations must pass this guard before touching CDP.
   */
  requireAgentControl(): Space {
    const space = this.selectedSpace();
    if (!space) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    if (space.ownership !== "agent") {
      throw makeEgoError(
        "EGO_TASK_SPACE_USER_IN_CONTROL",
        "task space is under user control; claim or takeOver before browser operations",
      );
    }
    return cloneSpace(space);
  }

  /**
   * Page ops / snapshot blocked when no selection or ownership is user /
   * agentDelegatedToUser (agent control required).
   */
  isPageControlBlocked(): boolean {
    const space = this.selectedSpace();
    if (!space) return true;
    return (
      space.ownership === "user" || space.ownership === "agentDelegatedToUser"
    );
  }

  assignTarget(targetId: string, spaceId?: number): void {
    const destId = spaceId ?? this.currentSelection();
    if (destId === null || destId === undefined) {
      throw Object.assign(new Error("task space not selected"), {
        error_code: "EGO_TASK_SPACE_NOT_SELECTED",
      });
    }
    const dest = this.findSpace(destId);
    if (!dest) {
      throw Object.assign(new Error(`task space not found: ${destId}`), {
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      });
    }
    for (const s of this.spaces) {
      const idx = s.targetIds.indexOf(targetId);
      if (idx !== -1) s.targetIds.splice(idx, 1);
      if (s.activeTargetId === targetId) delete s.activeTargetId;
    }
    if (!dest.targetIds.includes(targetId)) {
      dest.targetIds.push(targetId);
    }
    // A tab that was just created for or moved into a space is the one the
    // agent is about to use.
    dest.activeTargetId = targetId;
    dest.lastUsedAt = Date.now();
  }

  /** Record a Target.activateTarget on a tab of the selected space. */
  activateTarget(targetId: string): void {
    const space = this.selectedSpace();
    if (space && space.targetIds.includes(targetId)) {
      space.activeTargetId = targetId;
      space.lastUsedAt = Date.now();
    }
  }

  /**
   * The tab `page` should attach to: the last activated one, else the last
   * assigned. Null when the selected space has no tabs.
   */
  activeTargetForSelected(): string | null {
    const space = this.selectedSpace();
    if (!space) return null;
    if (
      space.activeTargetId &&
      space.targetIds.includes(space.activeTargetId)
    ) {
      return space.activeTargetId;
    }
    return space.targetIds[space.targetIds.length - 1] ?? null;
  }

  targetsForSelected(): string[] {
    const space = this.selectedSpace();
    return space ? [...space.targetIds] : [];
  }

  /** Remove persisted memberships for targets that no longer exist in Chrome. */
  reconcileTargets(targetIds: Iterable<string>): void {
    const live = new Set(targetIds);
    for (const space of this.spaces) {
      space.targetIds = space.targetIds.filter((targetId) =>
        live.has(targetId),
      );
      if (space.activeTargetId && !live.has(space.activeTargetId)) {
        delete space.activeTargetId;
      }
    }
  }

  spaceIdForTarget(targetId: string): number | null {
    for (const s of this.spaces) {
      if (s.targetIds.includes(targetId)) return s.id;
    }
    return null;
  }

  /** Assign unknown targets to the user space (id 1). Known targets unchanged. */
  adoptOrphanTargets(targetIds: string[]): void {
    const user = this.findSpace(USER_SPACE_ID);
    if (!user) {
      this.spaces.unshift(bootstrapUserSpace());
    }
    const userSpace = this.findSpace(USER_SPACE_ID)!;
    for (const tid of targetIds) {
      if (this.spaceIdForTarget(tid) === null) {
        userSpace.targetIds.push(tid);
      }
    }
  }

  private findSpace(id: number): Space | undefined {
    return this.spaces.find((s) => s.id === id);
  }

  private selectedSpace(): Space | undefined {
    const id = this.currentSelection();
    if (id === null) return undefined;
    return this.findSpace(id);
  }

  private resetBootstrap(): void {
    this.nextId = USER_SPACE_ID + 1;
    this.selectedId = null;
    this.selections.clear();
    this.spaces = [bootstrapUserSpace()];
  }
}
