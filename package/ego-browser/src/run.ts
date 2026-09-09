import { Script } from "node:vm";
import {
  stdin as processStdin,
  stdout as processStdout,
  stderr as processStderr,
} from "node:process";

import { formatCliLogValue } from "./format.js";
import * as helpers from "./helpers.js";
import { installLegacySkillGuards } from "./legacy-skill-guard.js";
import { bufferOutput, flushSink, resetSink } from "./output-sink.js";

type WritableLike = {
  write(chunk: string): unknown;
};

type ReadableLike = {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type RunServices = {
  resetConnection(): Promise<void>;
  printUpdateBanner(stream: WritableLike): void;
  runDoctor(stream: WritableLike): Promise<number>;
};

export type RunMainOptions = {
  argv?: string[];
  stdout?: WritableLike;
  stderr?: WritableLike;
  stdin?: ReadableLike;
  stdinText?: string;
  env?: Record<string, string | undefined>;
  services?: Partial<RunServices>;
};

export const HELP = `ego-browser

Read the ego-browser skill for the default workflow and examples.

Typical usage:
  ego-browser <<'JS'
  await page.waitForLoadState()
  console.log(await page.info())
  JS

Helpers are pre-imported and the browser connection is prepared automatically.

Commands:
  ego-browser --doctor         inspect browser and connection state
  ego-browser --reload         reset the browser connection on next call
`;

export const USAGE = `Usage:
  ego-browser <<'JS'
  console.log(await page.info())
  JS
`;

export async function runMain(options: RunMainOptions = {}) {
  const argv = options.argv || process.argv.slice(2);
  const stdout = options.stdout || processStdout;
  const stderr = options.stderr || processStderr;
  const env = options.env || process.env;
  const services = {
    resetConnection: async () => {},
    printUpdateBanner: () => {},
    runDoctor: async () => 0,
    ...options.services,
  };

  if (argv[0] === "-h" || argv[0] === "--help") {
    write(stdout, HELP);
    return 0;
  }
  if (argv[0] === "--doctor") {
    return services.runDoctor(stdout);
  }
  if (argv[0] === "--reload") {
    await services.resetConnection();
    write(stdout, "browser connection reset on next call\n");
    return 0;
  }
  if (argv[0] === "--debug-clicks") {
    env.EGO_BROWSER_DEBUG_CLICKS = "1";
    argv.shift();
  }
  if (argv.length > 0) {
    write(stderr, USAGE);
    return 2;
  }

  const code =
    options.stdinText !== undefined
      ? options.stdinText
      : await readAll(options.stdin || processStdin);
  if (!code.trim()) {
    write(stderr, USAGE);
    return 2;
  }

  services.printUpdateBanner(stderr);
  try {
    await execute(code, stdout);
  } catch (error) {
    write(stderr, formatScriptError(error));
    return 1;
  }
  return 0;
}

async function execute(code: string, stdout: WritableLike) {
  resetSink();
  // Helper chains (locator → resolver → cdp → runtime) are deeper than V8's
  // default 10 frames; keep enough so the heredoc frame survives for the report.
  Error.stackTraceLimit = 50;
  const context = await executionContext();
  Object.assign(globalThis, context);
  installLegacySkillGuards(globalThis as Record<string, unknown>);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const names = Object.keys(context);
  const values = Object.values(context);
  let fn;
  try {
    fn = new AsyncFunction(...names, `"use strict";\n${code}`);
  } catch (error) {
    // V8 reports a syntax error against the function wrapper, so the agent got
    // a token it never typed and no line at all. Recompile the bare script to
    // recover the real position.
    throw syntaxErrorWithLine(code, error);
  }
  let thrown;
  // A rejection nobody awaits would otherwise crash the process with Node's own
  // dump and lose the buffered output; surface it like any script error.
  let rejectUnhandled: (reason: unknown) => void = () => {};
  const unhandled = new Promise<never>((_, reject) => {
    rejectUnhandled = reject;
  });
  process.on("unhandledRejection", rejectUnhandled);
  try {
    await Promise.race([fn(...values), unhandled]);
  } catch (error) {
    thrown = error;
  } finally {
    process.off("unhandledRejection", rejectUnhandled);
  }
  try {
    await helpers.stopScreencast();
  } catch (error) {
    thrown ??= error;
  }
  // A thrown Error is reported by runMain, so flush as a thrown completion
  // (a hard stop drops the buffer and stays silent) and let it propagate.
  flushSink(stdout, Boolean(thrown));
  if (thrown) throw thrown;
}

export async function executionContext() {
  const agentHelpers = await helpers.loadAgentHelpers();
  // Single source of truth for the agent-facing surface: the same helperContext()
  // that installEgoSdk() exposes in the browser runtime, so the CLI and SDK paths
  // cannot drift apart (and `help` exists in both).
  const context: Record<string, any> = helpers.helperContext(agentHelpers);
  // Route the agent's primary output channel (console.log) through the output sink:
  // execute() flushes (or discards on hard stop) once the script settles, keeping the
  // CLI path identical to the SDK path. console.error/warn are left untouched. Each
  // heredoc runs in its own short-lived process, so overriding the global is per-run.
  console.log = (...args: unknown[]) => {
    bufferOutput(`${args.map(formatCliLogValue).join(" ")}\n`);
  };
  return context;
}

/**
 * Re-report a script syntax error at the line the agent actually wrote.
 * Compiling the script alone (inside an async arrow so top-level await stays
 * legal) gives V8 a position; a position past the last script line means the
 * script simply ends unclosed, which is more useful than the wrapper's token.
 */
function syntaxErrorWithLine(code: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  // Trailing blank lines (a heredoc always ends with one) are not where the
  // agent's unclosed bracket is.
  const lines = Math.max(1, code.replace(/\s+$/, "").split("\n").length);
  let reported: number | undefined;
  try {
    // eslint-disable-next-line no-new
    new Script(`(async () => {\n${code}\n})()`, {
      filename: "<anonymous_script>",
    });
  } catch (probe) {
    const match = /<anonymous_script>:(\d+)/.exec(
      (probe as Error)?.stack || "",
    );
    if (match) reported = Number(match[1]) - 1;
  }
  if (reported === undefined) {
    return Object.assign(new SyntaxError(message), {
      scriptFrames: [] as string[],
    });
  }
  const unterminated = reported > lines;
  const line = unterminated ? lines : reported;
  const text = unterminated
    ? "Unexpected end of input: a bracket, parenthesis, or quote is left open"
    : message;
  return Object.assign(new SyntaxError(text), {
    scriptFrames: [`<anonymous_script>:${line}`],
  });
}

// `at eval (eval at execute (...run.js), <anonymous>:L:C)` for top-level script
// code, `at inner (eval at ..., <anonymous>:L:C)` for a function it declared.
const SCRIPT_FRAME = /^\s+at (?:async )?(\S+) \(.*<anonymous>:(\d+):(\d+)\)$/;
// AsyncFunction wraps the body as `async function anonymous(...\n) {\n` and
// execute() prepends `"use strict";\n`: script line 1 is reported as line 4.
const SCRIPT_LINE_OFFSET = 3;

/**
 * One actionable report, no Node fatal-exception dump. An error raised inside
 * the heredoc (ReferenceError, user `throw`) keeps its name, message and script
 * frames; anything raised by a helper or the host collapses to one line plus
 * the script line that called it, when the async stack still knows it.
 * Frames in the harness, node internals or the host are never shown.
 */
export function formatScriptError(error: unknown): string {
  const declared = (error as { scriptFrames?: string[] })?.scriptFrames;
  if (Array.isArray(declared)) {
    const name = (error as Error).name || "Error";
    return (
      [
        `${name}: ${(error as Error).message}`,
        ...declared.map((f) => `    at ${f}`),
      ].join("\n") + "\n"
    );
  }
  const stack = error instanceof Error ? error.stack || "" : "";
  const message = error instanceof Error ? error.message : String(error);
  const lines = stack.split("\n");
  const firstFrame = lines.findIndex((line) => /^\s+at /.test(line));
  const frames = lines
    .slice(firstFrame < 0 ? lines.length : firstFrame)
    .map((line) => line.match(SCRIPT_FRAME))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => {
      const where = `<anonymous_script>:${Number(m[2]) - SCRIPT_LINE_OFFSET}:${m[3]}`;
      return m[1] === "eval" ? where : `${m[1]} (${where})`;
    });
  const fromScript =
    firstFrame >= 0 && SCRIPT_FRAME.test(lines[firstFrame] || "");
  if (fromScript) {
    const name = (error as Error).name || "Error";
    return (
      [`${name}: ${message}`, ...frames.map((f) => `    at ${f}`)].join("\n") +
      "\n"
    );
  }
  return `ego-browser: ${message}${frames.length ? ` (at ${frames[0]})` : ""}\n`;
}

function readAll(stream: ReadableLike) {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

function write(stream: WritableLike, text: string) {
  stream.write(text);
}
