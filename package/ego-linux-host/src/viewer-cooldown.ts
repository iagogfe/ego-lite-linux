/**
 * Viewer cooldown: minimize the browser windows while nobody watches the
 * desktop and no agent is driving the browser.
 *
 * A headed Chromium on a remote desktop (Selkies, noVNC, ...) keeps painting,
 * decoding video and running page animations after the last viewer left: the
 * compositor still maps the window, so every page reports `visible`. A
 * minimized window turns its pages `hidden`, which is Chromium's own signal to
 * stop rendering and throttle them.
 *
 * Hidden pages cannot be driven, though: wheel scrolling is dropped and
 * requestAnimationFrame never fires. So the windows only go down when the
 * viewer is away *and* the agents have been quiet for `idleMs`, and every ego
 * call restores them before it runs.
 *
 * The viewer signal comes from outside (`ego-browser --viewer away|present`),
 * typically a remote-desktop connect/disconnect hook. Until it is set to
 * away, nothing here touches a window.
 */

import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import type { CdpBridge } from "./cdp-bridge.js";

export const VIEWER_COOLDOWN_IDLE_MS = 30_000;

type WindowState = "normal" | "minimized" | "maximized" | "fullscreen";

export type ViewerCooldownDeps = {
  getCdp: () => Pick<CdpBridge, "send" | "listPageTargets">;
  /** Agents quiet for this long before the windows go down. */
  idleMs?: number;
  /**
   * Where the minimized windows are remembered. Without it a daemon that
   * exits while cooled leaves the browser minimized with nobody to restore
   * it, and a remote desktop often has no taskbar to click it back from.
   */
  statePath?: string;
  /** True while an agent connection is open; no cooldown under one. */
  hasClients?: () => boolean;
  log?: (line: string) => void;
};

export type ViewerCooldown = {
  /** Record whether someone is watching; present restores right away. */
  setViewer(present: boolean): Promise<void>;
  /** An ego call is starting: restore the windows before it runs. */
  beginCall(): Promise<void>;
  /** An ego call finished: schedule the cooldown once all calls are done. */
  endCall(): void;
  /** A client disconnected: the last one leaving can start the idle timer. */
  clientClosed(): void;
  status(): { viewer: "present" | "away"; cooled: boolean };
  dispose(): void;
};

export function createViewerCooldown(deps: ViewerCooldownDeps): ViewerCooldown {
  const idleMs = deps.idleMs ?? VIEWER_COOLDOWN_IDLE_MS;
  const log = deps.log ?? (() => {});
  // Present until told otherwise: a host without the hook behaves as before.
  let viewerPresent = true;
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Windows this module minimized, with the state to put them back in.
  const cooled = new Map<number, WindowState>(loadCooled(deps.statePath));
  // Cool and restore never interleave: a restore racing a half-done cool
  // would leave a window minimized under a running agent call.
  let tail: Promise<void> = Promise.resolve();

  function serialize(op: () => Promise<void>): Promise<void> {
    const next = tail.then(op, op);
    tail = next.catch(() => undefined);
    return next;
  }

  const busy = () => calls > 0 || (deps.hasClients?.() ?? false);

  async function persist(): Promise<void> {
    if (!deps.statePath) return;
    try {
      if (cooled.size === 0) await rm(deps.statePath, { force: true });
      else await writeFile(deps.statePath, JSON.stringify([...cooled]));
    } catch {
      // Best effort: losing it only costs the restore after a restart.
    }
  }

  async function windowIds(): Promise<number[]> {
    const cdp = deps.getCdp();
    const ids = new Set<number>();
    for (const page of await cdp.listPageTargets()) {
      try {
        const res = await cdp.send("Browser.getWindowForTarget", {
          targetId: page.targetId,
        });
        if (typeof res?.windowId === "number") ids.add(res.windowId);
      } catch {
        // The tab closed between the list and the lookup.
      }
    }
    return [...ids];
  }

  async function cool(): Promise<void> {
    if (viewerPresent || busy() || cooled.size > 0) return;
    const cdp = deps.getCdp();
    for (const windowId of await windowIds()) {
      // Re-checked per window: an agent call may arrive mid-loop, and its
      // restore is queued behind this one.
      if (viewerPresent || busy()) break;
      try {
        const { bounds } = await cdp.send("Browser.getWindowBounds", {
          windowId,
        });
        const state = (bounds?.windowState ?? "normal") as WindowState;
        if (state !== "minimized") {
          await cdp.send("Browser.setWindowBounds", {
            windowId,
            bounds: { windowState: "minimized" },
          });
        }
        // An already minimized window is recorded too: whatever left it down
        // (a restore that did not take, an earlier daemon), the next agent
        // call needs it up, and on a remote desktop nobody else will raise it.
        cooled.set(windowId, state === "minimized" ? "normal" : state);
        await persist();
      } catch {
        // A window that went away or refuses to minimize just stays as is.
      }
    }
    if (cooled.size > 0)
      log(`viewer cooldown: minimized ${cooled.size} window(s)`);
  }

  /**
   * Bring every minimized window back, to the state recorded when it was
   * cooled. Sweeps all windows, not just the recorded ones, so a window left
   * down by a lost record still comes back when the viewer returns.
   */
  async function restore(): Promise<void> {
    const cdp = deps.getCdp();
    const saved = new Map(cooled);
    let restored = 0;
    for (const windowId of new Set([...(await windowIds()), ...saved.keys()])) {
      try {
        const { bounds } = await cdp.send("Browser.getWindowBounds", {
          windowId,
        });
        if (bounds?.windowState !== "minimized") continue;
        // Un-minimize through "normal": on Wayland (labwc) a minimized
        // window asked straight for "maximized" stays minimized.
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
        const target = saved.get(windowId) ?? "normal";
        if (target !== "normal") {
          await cdp.send("Browser.setWindowBounds", {
            windowId,
            bounds: { windowState: target },
          });
        }
        restored++;
      } catch {
        // The window closed while cooled; nothing to bring back.
      }
    }
    cooled.clear();
    await persist();
    if (restored > 0) log(`viewer cooldown: restored ${restored} window(s)`);
  }

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function schedule(): void {
    cancelTimer();
    if (viewerPresent || busy()) return;
    timer = setTimeout(() => {
      timer = undefined;
      void serialize(cool).catch(() => undefined);
    }, idleMs);
    // Never hold the daemon open just to minimize a window.
    timer.unref?.();
  }

  return {
    async setViewer(present) {
      viewerPresent = present;
      if (present) {
        cancelTimer();
        await serialize(restore);
      } else {
        schedule();
      }
    },
    async beginCall() {
      calls++;
      cancelTimer();
      // Wait out a cool in flight, then restore only if it minimized
      // something: the common case costs no CDP round trip.
      if (viewerPresent && cooled.size === 0) return;
      await serialize(async () => {
        if (cooled.size > 0) await restore();
      });
    },
    endCall() {
      calls = Math.max(0, calls - 1);
      if (calls === 0) schedule();
    },
    clientClosed() {
      if (calls === 0) schedule();
    },
    status() {
      return {
        viewer: viewerPresent ? "present" : "away",
        cooled: cooled.size > 0,
      };
    },
    dispose() {
      cancelTimer();
    },
  };
}

function loadCooled(statePath?: string): [number, WindowState][] {
  if (!statePath) return [];
  try {
    const entries = JSON.parse(readFileSync(statePath, "utf8"));
    return Array.isArray(entries)
      ? entries.filter(
          (e) => Array.isArray(e) && typeof e[0] === "number" && e[1],
        )
      : [];
  } catch {
    return [];
  }
}
