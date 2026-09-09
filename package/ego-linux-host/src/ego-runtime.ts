/**
 * Daemon-side implementations of globalThis.ego methods.
 *
 * Enforces Task Space isolation (listTabs / createTab) and user-control
 * blocks on snapshot / page-domain and mutable browser-level CDP.
 */

import type { CdpBridge } from "./cdp-bridge.js";
import { makeEgoError } from "./errors.js";
import type { RpcEvent } from "./rpc.js";
import { snapshotPage, type SnapshotOptions } from "./snapshot-engine.js";
import { currentClientId, type SpaceManager } from "./space-manager.js";

/** Browser-level CDP domains used for activity labeling. */
function isBrowserLevelMethod(method: string): boolean {
  return method.startsWith("Target.") || method.startsWith("Browser.");
}

/**
 * Commands that can rescue a wedged tab: the browser process carries them out,
 * not the stuck renderer, so they must reach Chrome even when the tab is
 * marked unresponsive — they are the way out we recommend.
 */
const RECOVERY_METHODS = /^Page\.(navigate|reload|close|stopLoading)$/;

/** The only browser-level command allowed without agent ownership. */
const READ_ONLY_BROWSER_METHODS = new Set(["Browser.getVersion"]);

function isReadOnlyBrowserMethod(method: string): boolean {
  return READ_ONLY_BROWSER_METHODS.has(method);
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
  /** Idle time after which an agent space's tabs are closed (default 2h). */
  staleSpaceTtlMs?: number;
  /**
   * Viewport applied to each tab the agent creates. Set only in headless,
   * where there is no real window to inherit a size from.
   */
  viewport?: { width: number; height: number };
  /** Operational log for events a user would need explained (tabs closed). */
  log?: (line: string) => void;
  /** Cap on one client's focus turn (default 2s; tests shrink it). */
  focusMaxMs?: number;
  /** Silence after which a tab is called unresponsive (default 5s). */
  stuckAfterMs?: number;
  /** How long the liveness probe waits (default 400ms). */
  probeTimeoutMs?: number;
  /** Ceiling on a single focus turn (default 8s). */
  turnMaxMs?: number;
};

/**
 * How long an agent task space may sit untouched before its tabs are closed.
 * ponytail: a fixed 2h, tuned by EGO_AGENT_SPACE_TTL_MS. Heredoc rounds are
 * seconds apart, so 2h of silence means the session is over; raise it if
 * someone runs genuinely long-lived spaces.
 */
export const DEFAULT_STALE_SPACE_TTL_MS = 2 * 60 * 60 * 1000;

/** Filler label: the harness reads the page constantly between real actions. */
export const READING = "lendo página";

/**
 * Short pt-BR label for the badge, derived from the CDP method actually in
 * flight. Reading the real method keeps the badge honest: it can only say
 * "clicando" when a click is being dispatched.
 */
export function actionLabel(cdpMethod: string): string {
  if (
    cdpMethod.startsWith("Input.dispatchKey") ||
    cdpMethod === "Input.insertText"
  ) {
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
  /** A client disconnected: drop anything it still holds (focus lease). */
  releaseClient(clientId: string): void;
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

type UrlMatchMode = "exact" | "origin" | "origin+path" | "includes";

type ReusableTab = {
  targetId: string;
  title: string;
  url: string;
};

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

  // The harness and the daemon share one CDP socket, each with its own id
  // counter starting at 1. Harness ids are rewritten into a range the daemon's
  // counter never reaches, so a response can only ever land on its own sender,
  // and only responses the harness asked for are forwarded back (with the
  // harness's original id restored). Events carry no id and always pass.
  // The sender is recorded too: every harness numbers from 1, so broadcasting
  // a response would let another process match it to its own pending request.
  // ponytail: 1e9 offset assumes the daemon sends < 1e9 CDP requests per life.
  const HARNESS_ID_BASE = 1_000_000_000;
  let nextHarnessId = HARNESS_ID_BASE;
  const harnessIds = new Map<
    number,
    {
      originalId: unknown;
      clientId: string | undefined;
      /** This message took the focus lease and must give it back on reply. */
      holdsFocus?: boolean;
      /** Enough to send this read again if the lease is taken mid-flight. */
      payload?: Record<string, unknown>;
      targetId?: string | null;
      /** Shared with the retry: the first reply to arrive wins. */
      answered?: { done: boolean };
      /** Already re-queued once; a second preemption fails it instead. */
      retried?: boolean;
      /** Fires if the tab never answers this command. */
      watchdog?: ReturnType<typeof setTimeout>;
      /** When this read last reached Chrome, for the budget. */
      sentAt?: number;
      /** Still waiting on Chrome; false once settled or given up on. */
      pending?: boolean;
    }
  >();

  function attachCdpForwarding(): () => void {
    if (detachCdp) {
      detachCdp();
      detachCdp = undefined;
    }
    const cdp = deps.getCdp();
    const handler = (msg: any) => {
      let to: string | undefined;
      if (msg && msg.id != null) {
        const entry = harnessIds.get(msg.id);
        if (!entry) return;
        harnessIds.delete(msg.id);
        entry.pending = false;
        if (entry.watchdog) clearTimeout(entry.watchdog);
        // The tab spoke: whatever we concluded about it is stale.
        if (entry.targetId) lastAlive.set(entry.targetId, Date.now());
        clearTabStuck(entry.targetId);
        to = entry.clientId;
        if (entry.holdsFocus) {
          focusInFlight = Math.max(0, focusInFlight - 1);
          if (entry.clientId) releaseFocus(entry.clientId);
        }
        // A re-queued read has two ids in flight; only the first reply counts.
        if (entry.answered) {
          if (entry.answered.done) return;
          entry.answered.done = true;
        }
        msg = { ...msg, id: entry.originalId };
      }
      emit({
        ...(to !== undefined ? { to } : {}),
        event: "cdp.message",
        params: { payload: JSON.stringify(msg) },
      });
    };
    detachCdp = cdp.onMessage(handler);
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
    // No selected space is kept as an empty view for daemon startup. Once a
    // space is selected, tab metadata is private to the agent-owned space.
    if (deps.spaceManager.selected()) {
      deps.spaceManager.requireAgentControl();
    }
    const allowed = new Set(deps.spaceManager.targetsForSelected());
    const all = await deps.getCdp().listPageTargets();
    const filtered = all.filter((t) => allowed.has(t.targetId));
    // The harness attaches `page` to the tab flagged active, so this must be
    // the space's own record, not Chrome's list order (which is arbitrary and
    // ignores Target.activateTarget).
    const recorded = deps.spaceManager.activeTargetForSelected();
    const activeId = filtered.some((t) => t.targetId === recorded)
      ? recorded
      : filtered[filtered.length - 1]?.targetId;
    const tabs = filtered.map((t, index) => ({
      targetId: t.targetId,
      title: t.title,
      url: t.url,
      active: t.targetId === activeId,
      index,
    }));
    return { tabs };
  }

  async function createTab(params: { url?: string } = {}): Promise<{
    targetId: string;
  }> {
    deps.spaceManager.requireAgentControl();
    const url =
      typeof params?.url === "string" && params.url !== ""
        ? params.url
        : "about:blank";
    // Chrome focuses a tab the moment it is created, which silently takes
    // focus from whoever holds the lease and leaves their read hanging. The
    // creator is not reading, so focus goes straight back to the holder.
    const readerTab = focusedTargetId;
    const readerId = focusHolder;
    const targetId = await deps.getCdp().createTarget(url);
    focusedTargetId = targetId;
    deps.spaceManager.assignTarget(targetId);
    await applyViewport(targetId);
    if (readerTab && readerId !== null && readerId !== currentClientId()) {
      await ensureTabActive(readerTab);
    }
    return { targetId };
  }

  /**
   * Give a freshly created agent tab the launch viewport.
   *
   * `--window-size` cannot do this: it sizes the window and Chrome subtracts
   * its own UI, so the viewport arrives short by an amount that varies. This
   * is the same command `page.setViewportSize` uses, and it is applied once at
   * creation, so an agent that sets its own size later simply wins.
   */
  async function applyViewport(targetId: string): Promise<void> {
    const viewport = deps.viewport;
    if (!viewport) return;
    try {
      const cdp = deps.getCdp();
      const sessionId = await cdp.attach(targetId);
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 0,
          mobile: false,
        },
        sessionId,
      );
    } catch {
      // Never fail tab creation over the viewport; the tab still works.
    }
  }

  /**
   * Find a matching tab **inside the selected agent space**. Tabs of other
   * spaces are never candidates: moving one would hand this agent another
   * agent's page and leave that space empty without any signal.
   */
  async function findReusableTab(
    params: {
      url?: string;
      match?: UrlMatchMode;
    } = {},
  ): Promise<ReusableTab | null> {
    const selected = deps.spaceManager.selected();
    if (!selected || selected.ownership !== "agent") {
      return null;
    }
    if (typeof params?.url !== "string" || params.url === "") {
      return null;
    }

    const match = isUrlMatchMode(params?.match) ? params.match : "origin";
    const selectedIds = new Set(selected.targetIds);
    const pages = await deps.getCdp().listPageTargets();
    const matching = pages.filter(
      (page) =>
        selectedIds.has(page.targetId) &&
        tabMatchesUrl(page.url, params.url!, match),
    );
    const existing = matching[matching.length - 1];
    if (!existing) {
      return null;
    }

    deps.spaceManager.assignTarget(existing.targetId);
    return {
      targetId: existing.targetId,
      title: existing.title,
      url: existing.url,
    };
  }

  /**
   * Attach to the space's recorded active tab, the same one listTabs flags for
   * the harness. Falls back to deps.ensureSession (last live tab) when the
   * recorded tab is gone.
   */
  /**
   * Chrome answers accessibility queries only for the tab it has focused:
   * on any other tab `Accessibility.queryAXTree` never replies and the caller
   * dies on the 15s timeout. Task spaces hand each client its own tab, so the
   * tab a client is about to read is usually NOT the focused one.
   *
   * Activating is idempotent and cheap, and we already track the focused tab
   * (the harness's own `Target.activateTarget` goes through sendCDPMessage),
   * so a client that keeps working in one space pays for it once.
   */
  let focusedTargetId: string | null = null;

  /**
   * Only one tab can be focused, so accessibility reads take turns: activate,
   * read, release. Without this two clients steal focus from each other and
   * whoever activated last is the only one that answers — the rest hang until
   * the CDP timeout. Serialized they cost ~400ms each; that is the price of
   * Chrome having a single focused tab, not a queue we chose to add.
   */
  let focusHolder: string | null = null;
  const focusWaiters: Array<{ clientId: string; resolve: () => void }> = [];
  /** Reads of the holder still awaiting a reply. Handing the lease over now
   * would leave them hanging: activating another tab is what kills them. */
  let focusInFlight = 0;
  let focusDeadlineTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * A wedged renderer never answers, and its lease would hold the queue for
   * the whole CDP timeout. Past this the lease is handed on: the stuck read is
   * already doomed, and everyone else waits seconds, not a timeout.
   * ponytail: fixed cap, ~5x a heavy wikipedia read (300-400ms measured
   * inside the turn); raise it if a legitimate read ever loses focus here.
   */
  const FOCUS_MAX_MS = deps.focusMaxMs ?? 2000;
  /**
   * Absolute ceiling on one turn. A tab can wedge *after* it passed the
   * liveness check, and then its read holds the turn until the client's own
   * CDP timeout. Past this the host probes once more: still silent means the
   * page died mid-read, and the turn goes back to everyone else.
   * ponytail: 8s, above the heaviest healthy read measured (5.5s for a 15k
   * node tree); a page slower than that loses its turn and says so.
   */
  const TURN_MAX_MS = deps.turnMaxMs ?? 8000;
  let turnStartedAt = 0;

  function armFocusDeadline(): void {
    if (turnStartedAt === 0) turnStartedAt = Date.now();
    if (focusDeadlineTimer) clearTimeout(focusDeadlineTimer);
    focusDeadlineTimer = setTimeout(async () => {
      // Before taking a turn away, ask whether the tab is actually stuck. A
      // heavy but healthy read (a 10k-node accessibility tree) is using the
      // turn, and re-queueing it makes Chrome start the whole tree over —
      // it would never finish. Only a silent renderer loses its turn.
      // A read that is still running belongs to a tab we already vouched for;
      // taking its turn away restarts the whole tree and it never finishes.
      // Past the ceiling, ask once whether the tab is still there.
      if (focusInFlight > 0) {
        const heldFor = Date.now() - turnStartedAt;
        const tab = focusedTargetId;
        if (heldFor < TURN_MAX_MS || !tab || (await tabAnswers(tab))) {
          armFocusDeadline();
          return;
        }
        markTabStuck(tab, "a read that was already running");
        return;
      }
      const victim = focusHolder;
      const orphans = victim === null ? [] : orphanedReads(victim);
      // Daemon-side reads (snapshot) are not in the id map: count them.
      const daemonSide = Math.max(0, focusInFlight - orphans.length);
      const parts: string[] = [];
      if (orphans.length > 0) {
        // Aggregated, never enumerated: one wedged client can pile up over a
        // thousand identical reads, and a single log line that lists them all
        // is 58KB of the same text.
        const groups = new Map<string, number>();
        for (const o of orphans) {
          const space = o.entry.targetId
            ? (deps.spaceManager.spaceIdForTarget(o.entry.targetId) ?? "?")
            : "?";
          const key = `${o.method} space=${space} tab=${String(
            o.entry.targetId ?? "?",
          ).slice(0, 8)} ${o.retry ? "re-queued" : "failed (stuck twice)"}`;
          groups.set(key, (groups.get(key) ?? 0) + 1);
        }
        for (const [key, count] of groups) parts.push(`${count}x ${key}`);
      }
      if (daemonSide > 0) {
        const space =
          deps.spaceManager.spaceIdForTarget(focusedTargetId ?? "") ?? "?";
        parts.push(
          `${daemonSide}x snapshot space=${space} tab=${String(
            focusedTargetId ?? "?",
          ).slice(0, 8)} kept reading without the turn`,
        );
      }
      if (parts.length > 0) {
        deps.log?.(
          `focus turn taken from client ${victim} after ${FOCUS_MAX_MS}ms: ` +
            parts.join("; "),
        );
      }
      passFocus();
      for (const orphan of orphans) {
        if (orphan.retry) void resendRead(orphan);
        else void resendRead(orphan);
      }
    }, FOCUS_MAX_MS);
    focusDeadlineTimer.unref?.();
  }

  /**
   * Reads of `clientId` that were in flight when its turn was taken. Chrome
   * will not answer them now that another tab has focus, so they are dropped
   * from the id map and sent again once this client's turn comes back.
   */
  function orphanedReads(
    clientId: string,
  ): Array<{ id: number; method: string; entry: any; retry: boolean }> {
    const orphans: Array<{
      id: number;
      method: string;
      entry: any;
      retry: boolean;
    }> = [];
    for (const [id, entry] of harnessIds) {
      if (entry.holdsFocus && entry.clientId === clientId && entry.payload) {
        // The re-send arms its own watchdog; leaving this one running would
        // judge the tab on a clock that no longer matches any pending send.
        if (entry.watchdog) clearTimeout(entry.watchdog);
        orphans.push({
          id,
          method: String(entry.payload.method ?? "?"),
          entry,
          // Always re-queued: losing a turn says nothing about the tab, and
          // the renderer probe is what decides whether it is still there.
          retry: true,
        });
        harnessIds.delete(id);
      }
    }
    return orphans;
  }

  /**
   * A page command sent to a tab whose renderer is stuck never comes back.
   * One is enough to learn it: after this long with no reply the tab is
   * marked, every pending and subsequent command for it fails at once, and
   * the mark lifts the moment that tab answers anything again.
   *
   * Liveness is established *before* the work starts, never during it.
   * While a heavy read runs, a busy renderer and a dead one look identical —
   * a 15k-node accessibility tree stops answering anything, exactly like an
   * infinite loop. Asking first separates them: a tab that answers is alive
   * and its slow command is left alone however long it takes; a tab that does
   * not answer is stuck before it costs anyone a timeout or a turn.
   */
  /**
   * How long a tab's last reply vouches for it. Inside this window a page
   * command goes straight through; outside it, the tab is asked first. Kept
   * short because the probe is cheap (1.2ms on a live tab, measured) and
   * stale confidence is what lets a freshly wedged tab cost a full timeout.
   */
  const ALIVE_FOR_MS = deps.stuckAfterMs ?? 250;
  const lastAlive = new Map<string, number>();
  /** A live tab answers this in milliseconds; a wedged one never does. */
  const PROBE_TIMEOUT_MS = deps.probeTimeoutMs ?? 400;
  const stuckTabs = new Map<string, string>();


  /**
   * Ask the tab directly whether it is alive. This is what makes the verdict
   * reversible: a tab that recovers proves it on the next attempt, from any
   * process, without the agent having to close anything.
   */
  async function tabAnswers(targetId: string): Promise<boolean> {
    try {
      const cdp = deps.getCdp();
      const sessionId = await cdp.attach(targetId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const probe = cdp.send("Page.getFrameTree", {}, sessionId);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        await Promise.race([probe, timeout]);
        return true;
      } finally {
        if (timer) clearTimeout(timer);
        probe.catch(() => undefined);
      }
    } catch {
      return false;
    }
  }

  /** The single sentence every path uses for this one cause. */
  function stuckTabMessage(targetId: string, method: string): string {
    const space = deps.spaceManager.spaceIdForTarget(targetId) ?? "?";
    return (
      `ego-host: this tab's renderer is not responding (space=${space}, ` +
      `tab=${targetId.slice(0, 8)}); it did not answer a liveness check ` +
      `before ${method}. A page stuck in a long-running script answers ` +
      `nothing at all, so reading it another way — page.info(), a CSS query, ` +
      `a snapshot — hangs the same way. If the page is merely busy, wait and ` +
      `retry: the host re-checks the tab on every attempt and lets it through ` +
      `the moment it answers. If it is not coming back, drop the tab: ` +
      `const [tab] = await browser.listTabs(); await ` +
      `browser.closeTab(tab.targetId); then browser.openOrReuseTab(url).`
    );
  }

  /**
   * True when the tab is known good, or proves it now. Cheap in the common
   * case: a tab that answered in the last ALIVE_FOR_MS is taken at its word,
   * so a run of commands pays for one probe, not one per command.
   */
  async function ensureTabAlive(
    targetId: string,
    method: string,
  ): Promise<boolean> {
    const seen = lastAlive.get(targetId);
    if (seen !== undefined && Date.now() - seen < ALIVE_FOR_MS) return true;
    if (await tabAnswers(targetId)) {
      lastAlive.set(targetId, Date.now());
      clearTabStuck(targetId);
      return true;
    }
    markTabStuck(targetId, method);
    return false;
  }

  function markTabStuck(targetId: string, method: string): void {
    if (stuckTabs.has(targetId)) return;
    const why = stuckTabMessage(targetId, method);
    stuckTabs.set(targetId, why);
    deps.log?.(
      `tab marked unresponsive: space=${
        deps.spaceManager.spaceIdForTarget(targetId) ?? "?"
      } tab=${targetId.slice(0, 8)} before ${method} (no reply to a ${PROBE_TIMEOUT_MS}ms liveness probe)`,
    );
    // Everything already waiting on that tab is waiting for nothing.
    for (const [id, entry] of [...harnessIds]) {
      if (entry.targetId === targetId) {
        harnessIds.delete(id);
        entry.pending = false;
        if (entry.watchdog) clearTimeout(entry.watchdog);
        // These reads are over: leaving them counted keeps the focus lease
        // pinned and makes the log report phantom readers.
        if (entry.holdsFocus) focusInFlight = Math.max(0, focusInFlight - 1);
        failRead(entry, why);
      }
    }
    if (focusedTargetId === targetId && focusHolder !== null) passFocus();
  }

  function clearTabStuck(
    targetId: string | undefined | null,
    why = "answered",
  ): void {
    if (targetId && stuckTabs.delete(targetId)) {
      deps.log?.(`tab no longer marked unresponsive (${why}): tab=${targetId.slice(0, 8)}`);
    }
  }

  /**
   * Answer the harness ourselves so a client whose tab is wedged fails in
   * seconds instead of waiting out its own CDP timeout (30s for
   * getFullAXTree) while everyone queues behind it.
   */
  function failRead(entry: any, why: string): void {
    if (entry.answered?.done) return;
    if (entry.answered) entry.answered.done = true;
    emit({
      ...(entry.clientId !== undefined ? { to: entry.clientId } : {}),
      event: "cdp.message",
      params: {
        payload: JSON.stringify({
          id: entry.originalId,
          error: { code: -32000, message: why },
        }),
      },
    });
  }

  /**
   * Send an orphaned read again: wait for the client's turn, focus its tab,
   * and reissue under a new id. Both ids stay mapped to the harness's original
   * id and share an `answered` flag, so whichever reply lands first is the one
   * forwarded and the other is discarded.
   */
  async function resendRead(orphan: {
    id: number;
    method: string;
    entry: any;
  }): Promise<void> {
    const { entry } = orphan;
    const clientId = entry.clientId;
    if (!clientId || entry.answered?.done) return;
    try {
      await acquireFocus(clientId);
      if (entry.answered?.done) {
        releaseFocus(clientId);
        return;
      }
      focusInFlight++;
      if (entry.targetId) await ensureTabActive(entry.targetId);
      const retryId = nextHarnessId++;
      const retryEntry: any = { ...entry, retried: true };
      // The silence clock keeps running across re-sends. Restarting it here
      // would mean a tab preempted every 2s is never silent for 3s and so
      // never judged, which is exactly the case this detector is for.

      harnessIds.set(retryId, retryEntry);
      deps.getCdp().sendRaw({ ...entry.payload, id: retryId });
    } catch {
      // The read simply stays unanswered; the harness times out as before.
    }
  }

  /** Hand the lease to the next waiter, or leave it free. */
  function passFocus(): void {
    if (focusDeadlineTimer) clearTimeout(focusDeadlineTimer);
    focusDeadlineTimer = undefined;
    turnStartedAt = 0;
    focusInFlight = 0;
    const next = focusWaiters.shift();
    if (next) {
      focusHolder = next.clientId;
      armFocusDeadline();
      next.resolve();
    } else {
      focusHolder = null;
    }
  }

  /**
   * Take the focus lease, waiting for the current holder.
   *
   * The holder reenters freely, which is what keeps the several
   * `Accessibility.*` messages of one getByRole from losing focus midway. It
   * is safe to reenter only because a holder with nothing in flight gives the
   * lease up the moment someone queues (see releaseFocus) — otherwise a client
   * reading in a loop never lets go and newcomers starve behind a whole
   * rotation instead of one turn.
   */
  async function acquireFocus(clientId: string): Promise<void> {
    if (focusHolder === clientId) return;
    if (focusHolder === null) {
      focusHolder = clientId;
      armFocusDeadline();
      return;
    }
    await new Promise<void>((resolve) => {
      focusWaiters.push({ clientId, resolve });
    });
  }

  /**
   * End of one read. Pass the lease on when someone is waiting and nothing is
   * in flight — between two messages there is no read to kill, so yielding
   * here costs the next message a turn and costs nobody a hang.
   */
  function releaseFocus(clientId: string): void {
    if (focusHolder !== clientId) return;
    if (focusInFlight > 0) return;
    if (focusWaiters.length > 0) passFocus();
  }

  /** Run one whole AX operation holding the lease (daemon-side reads). */
  async function withFocus<T>(operation: () => Promise<T>): Promise<T> {
    const clientId = currentClientId() ?? "local";
    await acquireFocus(clientId);
    // Counted like a harness read: a late reply from this same client would
    // otherwise see nothing in flight and hand the lease away mid-snapshot,
    // which activates another tab and hangs this read until the CDP timeout.
    focusInFlight++;
    try {
      return await operation();
    } finally {
      focusInFlight = Math.max(0, focusInFlight - 1);
      releaseFocus(clientId);
    }
  }

  async function ensureTabActive(targetId: string): Promise<void> {
    if (focusedTargetId === targetId) return;
    try {
      await deps.getCdp().send("Target.activateTarget", { targetId });
      focusedTargetId = targetId;
    } catch {
      // Best effort: a closed tab surfaces on the operation that follows.
    }
  }

  /**
   * @param focus whether the tab must be the focused one. Accessibility reads
   * need it; cosmetic work must not take focus from whoever is reading.
   */
  async function ensureActiveSession(focus = true): Promise<string> {
    const activeId = deps.spaceManager.activeTargetForSelected();
    if (activeId) {
      try {
        const sessionId = await deps.getCdp().attach(activeId);
        if (focus) await ensureTabActive(activeId);
        return sessionId;
      } catch {
        // target closed since it was recorded
      }
    }
    return deps.ensureSession();
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
    const snapshotTarget = deps.spaceManager.activeTargetForSelected();
    if (
      snapshotTarget &&
      !(await ensureTabAlive(snapshotTarget, "Accessibility.getFullAXTree"))
    ) {
      throw makeEgoError(
        "EGO_BROWSER_UNAVAILABLE",
        stuckTabs.get(snapshotTarget) ??
          stuckTabMessage(snapshotTarget, "Accessibility.getFullAXTree"),
      );
    }
    // Activate and read in one turn: another client stealing focus midway is
    // what leaves this read hanging.
    return withFocus(async () => {
      const sessionId = await ensureActiveSession();
      markActivity(READING);
      return snapshotPage(deps.getCdp(), sessionId, params);
    });
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
    const selected = deps.spaceManager.selected();
    const agentControlsSpace = selected?.ownership === "agent";
    const safeWithoutAgentControl =
      selected !== null && isReadOnlyBrowserMethod(method);

    if (!agentControlsSpace && !safeWithoutAgentControl) {
      emitSendError(
        "task space is under user control; claim or takeOver before browser operations",
        "EGO_TASK_SPACE_USER_IN_CONTROL",
      );
      return { ok: true };
    }

    if (pageDomain) {
      markActivity(actionLabel(method));
    }
    if (method === "Target.closeTarget") {
      // The tab is gone; its verdict must not outlive it and block the space.
      const closed = msg?.params?.targetId;
      if (typeof closed === "string") {
        clearTabStuck(closed);
        // Without this the space keeps pointing at a tab that no longer
        // exists, and the next call attaches to nothing.
        deps.spaceManager.forgetTarget(closed);
      }
    }
    if (RECOVERY_METHODS.test(method)) {
      // A fresh document means a fresh renderer; let the tab prove itself,
      // and hold off judging it while the new one comes up.
      // Optimistic: the tab has not answered yet, a new document is coming.
      clearTabStuck(deps.spaceManager.activeTargetForSelected(), "navigating");
    }
    if (method === "Target.activateTarget") {
      const targetId = msg?.params?.targetId;
      if (typeof targetId === "string") {
        // Focusing a tab is what kills another client's in-flight read, so it
        // waits its turn like a read does. It is instant, so the lease goes
        // back right away: this client keeps focus only until someone reads.
        const clientId = currentClientId() ?? "local";
        await acquireFocus(clientId);
        deps.spaceManager.activateTarget(targetId);
        focusedTargetId = targetId;
        releaseFocus(clientId);
      }
    }
    // The harness reads the AX tree directly (getByRole and friends). Same
    // trap as snapshot, but fire-and-forget: the lease is held here and
    // released when the reply comes back (see attachCdpForwarding), so the
    // whole role operation owns the focus instead of each message.
    if (method.startsWith("Accessibility.")) {
      const clientId = currentClientId() ?? "local";
      await acquireFocus(clientId);
      focusInFlight++;
      const targetId = deps.spaceManager.activeTargetForSelected();
      if (targetId) await ensureTabActive(targetId);
    }

    // Page work on a tab known to be stuck fails now, with the one message,
    // instead of buying another timeout on a renderer that answers nothing.
    // Navigation is the exception and the way out: the browser process, not
    // the wedged renderer, carries it out, so it is the recipe we hand back.
    const pageTarget =
      pageDomain && !RECOVERY_METHODS.test(method)
        ? deps.spaceManager.activeTargetForSelected()
        : null;
    if (pageTarget && !(await ensureTabAlive(pageTarget, method))) {
      const why = stuckTabs.get(pageTarget) ?? stuckTabMessage(pageTarget, method);
      if (msg && msg.id != null) {
        failRead({ originalId: msg.id, clientId: currentClientId() }, why);
      } else {
        emitSendError(why, "EGO_BROWSER_UNAVAILABLE");
      }
      return { ok: true };
    }

    if (msg && msg.id != null) {
      const rewritten = nextHarnessId++;
      const isAxRead = method.startsWith("Accessibility.");
      const entry: any = {
        originalId: msg.id,
        clientId: currentClientId(),
        ...(pageTarget ? { targetId: pageTarget } : {}),
        ...(isAxRead
          ? {
              holdsFocus: true,
              // Kept so the read can be reissued if its turn is taken.
              payload: { ...msg, id: undefined },
              answered: { done: false },
            }
          : {}),
      };
      // Watchdog: silence from the tab means the renderer, not the queue.

      harnessIds.set(rewritten, entry);
      msg = { ...msg, id: rewritten };
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

  /**
   * Task spaces with their tabs, so choosing one does not require selecting
   * each in turn (useOrCreate has the side effect of selecting).
   *
   * `tabCount` is reported for every space, but tab urls/titles only for
   * agent-owned ones: the user space holds the person's own browsing and
   * listing spaces must not turn into a window onto it.
   */
  async function listTaskSpaces() {
    const spaces = deps.spaceManager.list();
    let byTarget = new Map<string, { title: string; url: string }>();
    try {
      const pages = await deps.getCdp().listPageTargets();
      byTarget = new Map(pages.map((p) => [p.targetId, p]));
    } catch {
      // No browser: still answer with the spaces and their counts.
    }
    const taskSpaces = spaces.map((space) => {
      const { targetIds } = space;
      const live = targetIds.filter((id) => byTarget.has(id));
      const record: Record<string, unknown> = {
        ...publicSpace(space),
        ...(space.recentTabTitles
          ? { recentTabTitles: [...space.recentTabTitles] }
          : {}),
        tabCount: byTarget.size ? live.length : targetIds.length,
      };
      if (space.ownership !== "user") {
        record.tabs = live.map((id) => ({
          targetId: id,
          title: byTarget.get(id)!.title,
          url: byTarget.get(id)!.url,
          active: id === space.activeTargetId,
        }));
      }
      return record;
    });
    return { taskSpaces };
  }

  /**
   * Close the tabs of agent spaces abandoned by earlier sessions. Nothing
   * closes an agent tab today, so on a browser the person keeps open for days
   * they pile up in their window. Runs when a new task space is created: a new
   * agent task is the moment old ones are provably over, and it costs one CDP
   * call per dead tab, off any hot path.
   */
  async function collectStaleSpaces(): Promise<void> {
    const ttlMs = deps.staleSpaceTtlMs ?? DEFAULT_STALE_SPACE_TTL_MS;
    if (ttlMs <= 0) return;
    const targetIds = deps.spaceManager.collectStaleAgentSpaces(ttlMs);
    if (targetIds.length > 0) {
      // "Why did my tab disappear" has exactly one answer, and it is this one.
      const idle =
        ttlMs >= 60_000
          ? `${Math.round(ttlMs / 60_000)}min`
          : `${Math.round(ttlMs / 1000)}s`;
      deps.log?.(
        `closed ${targetIds.length} tab(s) from agent task spaces idle over ${idle}`,
      );
    }
    for (const targetId of targetIds) {
      try {
        await deps.getCdp().send("Target.closeTarget", { targetId });
      } catch {
        // The tab may be gone already; the space record is dropped either way.
      }
    }
  }

  async function createTaskSpace(params: { name?: string } = {}) {
    await collectStaleSpaces();
    // A long-lived daemon otherwise accumulates every space ever created: the
    // startup prune never runs. Spaces a live client selected are kept, so a
    // space created a moment ago and not yet filled survives.
    const pruned = deps.spaceManager.pruneEmptyAgentSpaces(60_000);
    if (pruned > 0) deps.log?.(`pruned ${pruned} empty agent task space(s)`);
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
    deps.spaceManager.requireAgentControl();
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
      // Painting a badge must never steal focus: another client may be
      // mid-read, and its read dies the moment a different tab is focused.
      const sessionId = await ensureActiveSession(false);
      await deps.getCdp().send(
        "Runtime.evaluate",
        {
          expression: `${AGENT_OVERLAY_JS};__egoAgentOverlay.${call}`,
          returnByValue: true,
        },
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
    } else if (
      now >= holdUntil ||
      (shownLabel === READING && label !== READING)
    ) {
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
      case "findReusableTab":
        return findReusableTab(params);
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

  /**
   * A process that exits mid-turn would otherwise keep the lease until the
   * deadline, making every other client wait it out on each read.
   */
  function releaseClient(clientId: string): void {
    for (let i = focusWaiters.length - 1; i >= 0; i--) {
      if (focusWaiters[i]!.clientId === clientId) focusWaiters.splice(i, 1);
    }
    if (focusHolder === clientId) passFocus();
  }

  return { handle, onEvent, attachCdpForwarding, releaseClient };
}

function isUrlMatchMode(value: unknown): value is UrlMatchMode {
  return (
    value === "exact" ||
    value === "origin" ||
    value === "origin+path" ||
    value === "includes"
  );
}

function tabMatchesUrl(
  tabUrl: string,
  wantedUrl: string,
  match: UrlMatchMode,
): boolean {
  if (!tabUrl) return false;
  if (match === "includes") return tabUrl.includes(wantedUrl);

  let tab: URL;
  let wanted: URL;
  try {
    tab = new URL(tabUrl);
    wanted = new URL(wantedUrl);
  } catch {
    return match === "exact" && tabUrl === wantedUrl;
  }
  if (match === "origin") return tab.origin === wanted.origin;
  if (match === "origin+path") {
    return (
      tab.origin === wanted.origin &&
      trimSlash(tab.pathname) === trimSlash(wanted.pathname)
    );
  }
  return tab.href === wanted.href;
}

function trimSlash(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}
