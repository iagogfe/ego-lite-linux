/**
 * Daemon-side implementations of globalThis.ego methods.
 *
 * Enforces Task Space isolation (listTabs / createTab) and user-control
 * blocks on snapshot / page-domain CDP.
 */

import type { CdpBridge } from "./cdp-bridge.js";
import { makeEgoError } from "./errors.js";
import type { RpcEvent } from "./rpc.js";
import { snapshotPage, type SnapshotOptions } from "./snapshot-engine.js";
import type { SpaceManager } from "./space-manager.js";

/** Browser-level CDP domains that remain allowed under user control. */
function isBrowserLevelMethod(method: string): boolean {
  return method.startsWith("Target.") || method.startsWith("Browser.");
}

export type EgoRuntimeDeps = {
  spaceManager: SpaceManager;
  getCdp: () => CdpBridge;
  ensureSession: () => Promise<string>;
  /** Package version reported by ping when routed through runtime (optional). */
  version?: string;
  /** Silence after which the overlay drops to "idle" (default 5s; tests shrink it). */
  idleAfterMs?: number;
  /** Minimum time a label stays on screen before the next one (default 800ms). */
  labelHoldMs?: number;
};

/** Filler label: the harness reads the page constantly between real actions. */
export const READING = "lendo página";

/**
 * Short pt-BR label for the badge, derived from the CDP method actually in
 * flight. Reading the real method keeps the badge honest: it can only say
 * "clicando" when a click is being dispatched.
 */
export function actionLabel(cdpMethod: string): string {
  if (cdpMethod.startsWith("Input.dispatchKey") || cdpMethod === "Input.insertText") {
    return "digitando";
  }
  if (cdpMethod.startsWith("Input.")) return "clicando";
  if (cdpMethod === "Page.navigate" || cdpMethod === "Page.reload") {
    return "navegando";
  }
  if (
    cdpMethod === "Page.captureScreenshot" ||
    cdpMethod.startsWith("Page.startScreencast")
  ) {
    return "capturando";
  }
  if (
    cdpMethod.startsWith("Runtime.") ||
    cdpMethod.startsWith("Accessibility.") ||
    cdpMethod.startsWith("DOM.")
  ) {
    return READING;
  }
  return "trabalhando";
}

export type EgoRuntime = {
  handle(method: string, params?: any): Promise<any>;
  /** Subscribe to runtime-pushed events (cdp.message, cdp.sendError). */
  onEvent(handler: (ev: RpcEvent) => void): () => void;
  /**
   * Forward all CDP messages from the current bridge to event subscribers.
   * Call after connect / reconnect. Returns unsubscribe.
   */
  attachCdpForwarding(): () => void;
};

function normalizeMethod(method: string): string {
  if (method.startsWith("ego.")) return method.slice(4);
  return method;
}

function publicSpace(space: {
  taskId: string;
  id: number;
  name: string;
  createdBy: string;
  ownership: string;
  recentTabTitles?: string[];
}) {
  return {
    taskId: space.taskId,
    id: space.id,
    name: space.name,
    createdBy: space.createdBy,
    ownership: space.ownership,
    ...(space.recentTabTitles
      ? { recentTabTitles: [...space.recentTabTitles] }
      : {}),
  };
}

/**
 * In-page agent overlay with two states, so a glance at the tab answers three
 * questions: is the agent acting now, is this its tab, and did it stop.
 *
 * - `active`: thick pulsing frame, badge with the current action, cursor ring.
 * - `idle`: thin static frame, grey badge counting since the last action.
 *   It never disappears — a cleared overlay is indistinguishable from a tab
 *   the agent never touched.
 *
 * Idempotent: safe to re-evaluate on every call (re-injects after navigation).
 * Coordinates are viewport CSS px (same space as Input.dispatchMouseEvent).
 */
const AGENT_OVERLAY_JS = `(() => {
  if (globalThis.__egoAgentOverlay) return;
  const ID = "__ego_agent_overlay";
  let idleSince = 0;
  let clock;
  function ensure() {
    let root = document.getElementById(ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = ID;
    root.setAttribute("aria-hidden", "true");
    root.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;" +
      "transition:opacity .3s;opacity:1;";
    const style = document.createElement("style");
    // Moldura solida + halo interno: a moldura garante que a borda seja lida
    // como estado ("agente no comando"), o halo pulsa para dar movimento.
    style.textContent =
      "@keyframes __ego-pulse{0%,100%{box-shadow:inset 0 0 0 4px rgba(99,102,241,.95),inset 0 0 44px 10px rgba(99,102,241,.5)}" +
      "50%{box-shadow:inset 0 0 0 4px rgba(129,140,248,1),inset 0 0 80px 22px rgba(99,102,241,.8)}}" +
      "@keyframes __ego-badge-pulse{0%,100%{transform:translateX(-50%) scale(1)}" +
      "50%{transform:translateX(-50%) scale(1.06)}}";
    const glow = document.createElement("div");
    glow.style.cssText =
      "position:absolute;inset:0;animation:__ego-pulse 1.2s ease-in-out infinite;";
    const badge = document.createElement("div");
    badge.className = "__ego-badge";
    badge.style.cssText =
      "position:absolute;top:14px;left:50%;transform:translateX(-50%);" +
      "background:rgba(49,46,129,.96);color:#e0e7ff;font:600 15px/1.5 system-ui,sans-serif;" +
      "padding:7px 20px;border-radius:999px;white-space:nowrap;display:none;" +
      "box-shadow:0 4px 18px rgba(49,46,129,.55);letter-spacing:.02em;" +
      "animation:__ego-badge-pulse 1.2s ease-in-out infinite;";
    const ring = document.createElement("div");
    ring.className = "__ego-ring";
    ring.style.cssText =
      "position:absolute;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;" +
      "border:3px solid rgba(129,140,248,1);border-radius:50%;" +
      "background:rgba(99,102,241,.35);box-shadow:0 0 16px 4px rgba(99,102,241,.6);" +
      "transition:transform .2s ease-out;display:none;";
    root.append(style, glow, badge, ring);
    (document.body || document.documentElement).appendChild(root);
    return root;
  }
  function show() {
    const root = ensure();
    root.style.opacity = "1";
    return root;
  }
  /** "parado ha 40s" / "parado ha 3 min" — o relogio roda na propria pagina. */
  function idleText() {
    const s = Math.max(0, Math.round((Date.now() - idleSince) / 1000));
    return s < 60
      ? "agente parado ha " + s + "s"
      : "agente parado ha " + Math.round(s / 60) + " min";
  }
  function paint(state, label) {
    const root = show();
    const glow = root.children[1];
    const badge = root.querySelector(".__ego-badge");
    const ring = root.querySelector(".__ego-ring");
    clearInterval(clock);
    if (state === "idle") {
      idleSince = idleSince || Date.now();
      // moldura fina e imovel: marca a aba sem competir com a pagina
      glow.style.animation = "none";
      glow.style.boxShadow = "inset 0 0 0 2px rgba(99,102,241,.35)";
      badge.style.animation = "none";
      badge.style.background = "rgba(71,85,105,.92)";
      badge.style.font = "500 13px/1.4 system-ui,sans-serif";
      badge.textContent = idleText();
      badge.style.display = "block";
      ring.style.display = "none";
      clock = setInterval(function () { badge.textContent = idleText(); }, 15000);
      return;
    }
    idleSince = 0;
    glow.style.animation = "__ego-pulse 1.2s ease-in-out infinite";
    glow.style.boxShadow = "";
    badge.style.animation = "__ego-badge-pulse 1.2s ease-in-out infinite";
    badge.style.background = "rgba(49,46,129,.96)";
    badge.style.font = "600 15px/1.5 system-ui,sans-serif";
    if (label) badge.textContent = "agente " + label;
    badge.style.display = badge.textContent ? "block" : "none";
  }
  globalThis.__egoAgentOverlay = {
    setState: paint,
    pulse() {
      paint("active", "");
    },
    moveCursor(x, y) {
      paint("active", "");
      const ring = show().querySelector(".__ego-ring");
      ring.style.display = "block";
      ring.style.transform = "translate(" + x + "px," + y + "px)";
    },
    setLabel(label) {
      const badge = show().querySelector(".__ego-badge");
      badge.textContent = label;
      badge.style.display = label ? "block" : "none";
    },
  };
})()`;

/**
 * Create the ego method dispatcher used by the host daemon.
 */
export function createEgoRuntime(deps: EgoRuntimeDeps): EgoRuntime {
  const eventHandlers = new Set<(ev: RpcEvent) => void>();
  let detachCdp: (() => void) | undefined;

  function emit(ev: RpcEvent): void {
    for (const h of eventHandlers) {
      try {
        h(ev);
      } catch {
        // subscriber errors must not break the runtime
      }
    }
  }

  function onEvent(handler: (ev: RpcEvent) => void): () => void {
    eventHandlers.add(handler);
    return () => {
      eventHandlers.delete(handler);
    };
  }

  function attachCdpForwarding(): () => void {
    if (detachCdp) {
      detachCdp();
      detachCdp = undefined;
    }
    const cdp = deps.getCdp();
    const handler = (msg: any) => {
      emit({ event: "cdp.message", params: { payload: JSON.stringify(msg) } });
    };
    if (typeof cdp.onMessage === "function") {
      detachCdp = cdp.onMessage(handler);
    } else {
      // Fallback: events only (responses with id may be missed)
      detachCdp = cdp.onEvent(handler);
    }
    return () => {
      if (detachCdp) {
        detachCdp();
        detachCdp = undefined;
      }
    };
  }

  function emitSendError(message: string, error_code?: string): void {
    emit({
      event: "cdp.sendError",
      params: {
        message,
        ...(error_code ? { error_code } : {}),
      },
    });
  }

  async function listTabs(): Promise<{ tabs: any[] }> {
    const allowed = new Set(deps.spaceManager.targetsForSelected());
    const all = await deps.getCdp().listPageTargets();
    const filtered = all.filter((t) => allowed.has(t.targetId));
    const tabs = filtered.map((t, index) => ({
      targetId: t.targetId,
      title: t.title,
      url: t.url,
      active: index === filtered.length - 1,
      index,
    }));
    return { tabs };
  }

  async function createTab(params: { url?: string } = {}): Promise<{
    targetId: string;
  }> {
    const selected = deps.spaceManager.selected();
    if (!selected) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    const url =
      typeof params?.url === "string" && params.url !== ""
        ? params.url
        : "about:blank";
    const targetId = await deps.getCdp().createTarget(url);
    deps.spaceManager.assignTarget(targetId);
    return { targetId };
  }

  async function snapshot(params: SnapshotOptions = {}): Promise<{
    content: string;
    refs: any[];
  }> {
    if (deps.spaceManager.isPageControlBlocked()) {
      throw makeEgoError(
        "EGO_TASK_SPACE_USER_IN_CONTROL",
        "task space is under user control; claim or takeOver before page ops",
      );
    }
    const sessionId = await deps.ensureSession();
    markActivity(READING);
    return snapshotPage(deps.getCdp(), sessionId, params);
  }

  async function sendCDPMessage(params: {
    payload?: string;
  }): Promise<{ ok: true }> {
    const raw = params?.payload;
    if (typeof raw !== "string" || raw === "") {
      throw makeEgoError(
        "EGO_INVALID_ARGUMENT",
        "sendCDPMessage requires { payload: string }",
      );
    }

    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      emitSendError(
        `invalid CDP payload JSON: ${err instanceof Error ? err.message : String(err)}`,
        "EGO_INVALID_ARGUMENT",
      );
      return { ok: true };
    }

    const method = typeof msg?.method === "string" ? msg.method : "";
    const pageDomain = method ? !isBrowserLevelMethod(method) : true;

    if (pageDomain && deps.spaceManager.isPageControlBlocked()) {
      emitSendError(
        "task space is under user control; claim or takeOver before page ops",
        "EGO_TASK_SPACE_USER_IN_CONTROL",
      );
      return { ok: true };
    }

    if (pageDomain) {
      markActivity(actionLabel(method));
    }

    try {
      deps.getCdp().sendRaw(msg);
    } catch (err) {
      const code =
        err &&
        typeof err === "object" &&
        typeof (err as { error_code?: string }).error_code === "string"
          ? (err as { error_code: string }).error_code
          : "EGO_CDP_SEND_FAILED";
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : String(err);
      emitSendError(message, code);
    }
    return { ok: true };
  }

  async function listTaskSpaces() {
    return { taskSpaces: deps.spaceManager.listPublic() };
  }

  async function createTaskSpace(params: { name?: string } = {}) {
    const name =
      typeof params?.name === "string" && params.name !== ""
        ? params.name
        : "untitled";
    const space = deps.spaceManager.createAgentSpace(name);
    return publicSpace(space);
  }

  async function useTaskSpace(params: { id?: number } = {}) {
    const id = Number(params?.id);
    if (!Number.isFinite(id)) {
      return {
        error: "useTaskSpace requires { id: number }",
        error_code: "EGO_INVALID_ARGUMENT",
      };
    }
    const result = deps.spaceManager.use(id);
    if (result.ok === false) {
      return { error: result.error, error_code: result.error_code };
    }
    return publicSpace(result.space);
  }

  async function claimTaskSpace(params: { id?: number; name?: string } = {}) {
    const id = Number(params?.id);
    if (!Number.isFinite(id)) {
      throw makeEgoError(
        "EGO_INVALID_ARGUMENT",
        "claimTaskSpace requires { id: number }",
      );
    }
    try {
      const space = deps.spaceManager.claim(
        id,
        typeof params?.name === "string" ? params.name : undefined,
      );
      return publicSpace(space);
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        (err as { error_code?: string }).error_code
      ) {
        throw err;
      }
      throw makeEgoError(
        "EGO_OPERATION_FAILED",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function completeTaskSpace() {
    if (!deps.spaceManager.selected()) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    deps.spaceManager.completeKeep();
    return { ok: true };
  }

  async function closeTaskSpace() {
    if (!deps.spaceManager.selected()) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    const targetIds = deps.spaceManager.closeSelected();
    // Best-effort close page targets in Chrome
    const cdp = deps.getCdp();
    for (const targetId of targetIds) {
      try {
        await cdp.send("Target.closeTarget", { targetId });
      } catch {
        // ignore close failures
      }
    }
    return { ok: true };
  }

  async function handOffTaskSpace() {
    if (!deps.spaceManager.selected()) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    deps.spaceManager.handOff();
    return { ok: true };
  }

  async function takeOverTaskSpace() {
    if (!deps.spaceManager.selected()) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    deps.spaceManager.takeOver();
    return { ok: true };
  }

  /**
   * Best-effort injection of the in-page agent overlay (glow + label badge +
   * cursor ring). Cosmetic only: any failure (no tab, navigation in flight,
   * user control) is swallowed — it must never break an agent action.
   */
  async function injectOverlay(call: string): Promise<{ ok: true }> {
    try {
      if (deps.spaceManager.isPageControlBlocked()) return { ok: true };
      const sessionId = await deps.ensureSession();
      await deps.getCdp().send(
        "Runtime.evaluate",
        { expression: `${AGENT_OVERLAY_JS};__egoAgentOverlay.${call}`, returnByValue: true },
        sessionId,
      );
    } catch {
      // cosmetic effect; ignore all failures
    }
    return { ok: true };
  }

  // Any agent page activity (snapshot, page-domain CDP) marks the overlay
  // active — not just pointer actions, otherwise read-only tasks show nothing.
  // Fire-and-forget so it never adds latency to the hot path.
  const idleAfterMs = deps.idleAfterMs ?? 5000;
  // A label that flashes for 80ms is unreadable — measured on a real fill:
  // digitando → lendo página → digitando in under a second. Each label gets a
  // minimum time on screen; anything newer waits its turn.
  const labelHoldMs = deps.labelHoldMs ?? 800;
  let lastMark = 0;
  let shownLabel = "";
  let holdUntil = 0;
  let pendingLabel: string | null = null;
  let labelTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function paintLabel(label: string): void {
    shownLabel = label;
    lastMark = Date.now();
    holdUntil = lastMark + labelHoldMs;
    void injectOverlay(`setState("active",${JSON.stringify(label)})`);
  }

  function markActivity(label: string): void {
    const now = Date.now();
    if (label === shownLabel) {
      // Same action: nothing to repaint, except to re-inject after a
      // navigation wiped the overlay out of the fresh page context.
      pendingLabel = null;
      if (now - lastMark >= 1000) paintLabel(label);
    } else if (now >= holdUntil || (shownLabel === READING && label !== READING)) {
      // A real action beats the reading noise the harness emits between steps
      // (resolving a selector, reading a value back), even mid-hold — otherwise
      // the badge sits on "lendo página" through an entire fill.
      pendingLabel = null;
      paintLabel(label);
    } else {
      // Still holding the current label: queue this one. Only the newest
      // pending label survives — intermediates were never readable anyway.
      // Reading never displaces a queued real action, for the same reason.
      if (label !== READING || pendingLabel === null) pendingLabel = label;
      if (!labelTimer) {
        labelTimer = setTimeout(() => {
          labelTimer = undefined;
          const next = pendingLabel;
          pendingLabel = null;
          if (next && next !== shownLabel) paintLabel(next);
        }, holdUntil - now);
        labelTimer.unref?.();
      }
    }

    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      shownLabel = "";
      pendingLabel = null;
      void injectOverlay('setState("idle","")');
    }, idleAfterMs);
    // Never hold the daemon open just to dim a frame.
    idleTimer.unref?.();
  }

  async function animationHighlightMouseToPosition(
    params: { x?: number; y?: number } = {},
  ) {
    const x = Number(params?.x);
    const y = Number(params?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: true };
    return injectOverlay(`moveCursor(${x},${y})`);
  }

  async function setAgentTaskState(params: { label?: string } = {}) {
    const label = typeof params?.label === "string" ? params.label : "";
    return injectOverlay(`setLabel(${JSON.stringify(label)})`);
  }

  async function handle(method: string, params: any = {}): Promise<any> {
    const name = normalizeMethod(method);
    switch (name) {
      case "listTaskSpaces":
        return listTaskSpaces();
      case "createTaskSpace":
        return createTaskSpace(params);
      case "useTaskSpace":
        return useTaskSpace(params);
      case "claimTaskSpace":
        return claimTaskSpace(params);
      case "completeTaskSpace":
        return completeTaskSpace();
      case "closeTaskSpace":
        return closeTaskSpace();
      case "handOffTaskSpace":
        return handOffTaskSpace();
      case "takeOverTaskSpace":
        return takeOverTaskSpace();
      case "listTabs":
        return listTabs();
      case "createTab":
        return createTab(params);
      case "snapshot":
        return snapshot(params);
      case "sendCDPMessage":
        return sendCDPMessage(params);
      case "animationHighlightMouseToPosition":
        return animationHighlightMouseToPosition(params);
      case "setAgentTaskState":
        return setAgentTaskState(params);
      default:
        throw makeEgoError(
          "EGO_INVALID_ARGUMENT",
          `unknown ego method: ${method}`,
        );
    }
  }

  return { handle, onEvent, attachCdpForwarding };
}
