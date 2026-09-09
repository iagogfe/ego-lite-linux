import { writeFile } from "node:fs/promises";

import { agentWorkspace, loadEnv } from "./env.js";
import { browserCdp } from "./browser-runtime.js";

loadEnv();

export const NAME = process.env.EGO_BROWSER_NAME || "default";

async function defaultSend(req) {
  if (!req || typeof req !== "object" || !req.method) {
    throw new Error(
      `unsupported browser runtime request: ${JSON.stringify(req)}`,
    );
  }
  const response = await browserCdp(
    req.method,
    req.params || {},
    req.session_id,
  );
  return { result: response.result || {} };
}

export const state = {
  send: defaultSend,
  cdpOverride: null,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: process.platform,
  agentWorkspace: () => agentWorkspace(),
  writeFile,
  sessionId: null,
  sessionTargetId: null,
  sessionAt: 0,
  sessionInflight: null,
  preferredTargetId: null,
  defaultTimeout: 10000,
  // Implicit waits (element reads, and the "is it there yet" wait an action
  // does before pointing at its target) share this budget, so two spellings of
  // the same step cannot fail 7 seconds apart. An explicit `timeout` option or
  // page.setDefaultTimeout() still wins.
  implicitTimeout: 3000,
  // Last observed Network domain state on the default session (tracked in cdp()).
  networkDomainEnabled: false,
};

export async function send(req) {
  // `return await`: a bare `return promise` in an async function breaks the
  // async stack chain, and helper timeouts then lose the heredoc line.
  return await state.send(req);
}

export function setOverrides(overrides) {
  const previous = { ...state };
  Object.assign(state, overrides);
  return () => {
    Object.assign(state, previous);
  };
}
