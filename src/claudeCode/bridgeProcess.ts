import { appLogger } from "../core/logging";
import { createAbortController } from "../utils/apiHelpers";
import {
  CodexAppServerProcess,
  buildCodexLaunchEnvironment,
  buildPosixLaunchPath,
  getRuntimeEnvValue,
  resolveLocalBinary,
} from "../utils/codexAppServerProcess";
import { getRuntimePlatformInfo } from "../utils/runtimePlatform";
import { getClaudeBridgeAdapterDir, getClaudeBridgeUrl } from "./prefs";

export type BridgeState =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "running"; owner: "plugin" }
  | { kind: "running"; owner: "external" }
  | { kind: "stopping" }
  | { kind: "failed"; reason: string };

type BridgeListener = (state: BridgeState) => void;

type SubprocessPipe = { readString?: () => Promise<string> };

type BridgeSubprocess = {
  stdout?: SubprocessPipe;
  stderr?: SubprocessPipe;
  kill: (timeoutMs?: number) => Promise<unknown>;
  wait: () => Promise<{ exitCode?: number } | undefined>;
};

type OwnedChild = {
  proc: BridgeSubprocess;
  stderrLines: string[];
  stderrPartial: string;
  stderrDrained: Promise<void>;
  exited: Promise<void>;
  stopping: boolean;
  removeQuitBlocker: () => void;
};

export const BRIDGE_ENTRY_RELATIVE_PATH = "bin/start-bridge-server.ts";
const TSX_LOADER_RELATIVE_PATH = "node_modules/tsx/dist/loader.mjs";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const STDERR_LINES_KEPT = 20;
const FAILURE_REASON_MAX_CHARS = 300;

const DEFAULT_TIMING = {
  pollIntervalMs: 250,
  startTimeoutMs: 20_000,
  probeTimeoutMs: 1_000,
  stopGraceMs: 2_000,
  stopCapMs: 4_000,
  stderrTailWaitMs: 100,
};
let timing = { ...DEFAULT_TIMING };

let state: BridgeState = { kind: "stopped" };
let owned: OwnedChild | null = null;
let pendingStart: Promise<BridgeState> | null = null;
// Bumped by every stop so a start that is still resolving node or polling
// healthz can tell it was cancelled and must not adopt or keep its child.
let epoch = 0;
const listeners = new Set<BridgeListener>();

function setState(next: BridgeState): void {
  state = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (err) {
      appLogger.warn("Claude bridge: state listener failed", err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withCap<T>(task: Promise<T>, capMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, capMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function joinPath(dir: string, relative: string): string {
  const separator = getRuntimePlatformInfo().pathSeparator;
  const base = dir.replace(/[\\/]+$/, "");
  return [base, ...relative.split("/")].join(separator);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return Boolean(await (globalThis as any).IOUtils?.exists?.(path));
  } catch {
    return false;
  }
}

function toFileUrl(path: string): string {
  const fromPathUtils = (globalThis as any).PathUtils?.toFileURI?.(path);
  return typeof fromPathUtils === "string"
    ? fromPathUtils
    : `file://${encodeURI(path)}`;
}

/** Returns a user-facing hint when the folder cannot run the bridge. */
export async function validateBridgeAdapterDir(
  dir: string,
): Promise<string | null> {
  if (!dir.trim()) return "Choose the cc-llm4zotero-adapter folder first.";
  if (!(await fileExists(joinPath(dir, BRIDGE_ENTRY_RELATIVE_PATH)))) {
    return `${BRIDGE_ENTRY_RELATIVE_PATH} was not found in this folder.`;
  }
  if (!(await fileExists(joinPath(dir, TSX_LOADER_RELATIVE_PATH)))) {
    return "Dependencies are missing. Run npm install in this folder.";
  }
  return null;
}

function getBridgeEndpoint(): { host: string; port: string; url: string } {
  const url = getClaudeBridgeUrl().replace(/\/+$/, "");
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return { host: parsed.hostname, port, url };
}

async function isBridgeHealthy(): Promise<boolean> {
  let url: string;
  try {
    url = getBridgeEndpoint().url;
  } catch {
    return false;
  }
  const controller = createAbortController();
  const timer = setTimeout(() => controller.abort(), timing.probeTimeoutMs);
  try {
    const response = await fetch(`${url}/healthz`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { ok?: unknown } | null;
    return payload?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function stderrTail(child: OwnedChild): string {
  const text = [...child.stderrLines, child.stderrPartial.trim()]
    .filter(Boolean)
    .join("\n");
  return text.length > FAILURE_REASON_MAX_CHARS
    ? `…${text.slice(-FAILURE_REASON_MAX_CHARS)}`
    : text;
}

function appendStderr(child: OwnedChild, chunk: string): void {
  const lines = (child.stderrPartial + chunk).split(/\r?\n/);
  child.stderrPartial = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) child.stderrLines.push(line.trimEnd());
  }
  if (child.stderrLines.length > STDERR_LINES_KEPT) {
    child.stderrLines.splice(0, child.stderrLines.length - STDERR_LINES_KEPT);
  }
}

async function drain(
  pipe: SubprocessPipe | undefined,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (!pipe?.readString) return;
  while (true) {
    let chunk: string;
    try {
      chunk = await pipe.readString();
    } catch {
      return;
    }
    if (!chunk) return;
    onChunk(chunk);
  }
}

/**
 * Zotero's bootstrap returns before onShutdown on APP_SHUTDOWN, and
 * Subprocess does not kill live children when it shuts down, so without this
 * blocker quitting Zotero would leave the bridge running.
 */
function registerQuitBlocker(): () => void {
  try {
    const { AsyncShutdown } = (globalThis as any).ChromeUtils.importESModule(
      "resource://gre/modules/AsyncShutdown.sys.mjs",
    );
    const blocker = () => stopBridge().then(() => undefined);
    AsyncShutdown.quitApplicationGranted.addBlocker(
      "llm-for-zotero: stop Claude Code bridge",
      blocker,
    );
    return () => {
      try {
        AsyncShutdown.quitApplicationGranted.removeBlocker(blocker);
      } catch {
        /* already removed during shutdown */
      }
    };
  } catch {
    return () => {};
  }
}

function adoptChild(proc: BridgeSubprocess): OwnedChild {
  const child: OwnedChild = {
    proc,
    stderrLines: [],
    stderrPartial: "",
    stderrDrained: Promise.resolve(),
    exited: Promise.resolve(),
    stopping: false,
    removeQuitBlocker: registerQuitBlocker(),
  };
  void drain(proc.stdout, () => {});
  child.stderrDrained = drain(proc.stderr, (chunk) =>
    appendStderr(child, chunk),
  );
  child.exited = Promise.resolve(proc.wait())
    .catch(() => undefined)
    .then(async (result) => {
      await withCap(child.stderrDrained, timing.stderrTailWaitMs);
      child.removeQuitBlocker();
      if (owned !== child) return;
      owned = null;
      if (child.stopping) return;
      const code = result?.exitCode;
      const tail = stderrTail(child);
      setState({
        kind: "failed",
        reason: `bridge exited${typeof code === "number" ? ` with code ${code}` : ""}${tail ? `: ${tail}` : ""}`,
      });
    });
  return child;
}

async function terminate(child: OwnedChild): Promise<void> {
  child.stopping = true;
  await withCap(
    Promise.resolve(child.proc.kill(timing.stopGraceMs)),
    timing.stopCapMs,
  );
  await withCap(child.exited, timing.stderrTailWaitMs);
  if (owned === child) owned = null;
  child.removeQuitBlocker();
}

async function spawnBridge(adapterDir: string): Promise<BridgeSubprocess> {
  const node = await resolveLocalBinary("node");
  if (!node) {
    throw new Error(
      "node was not found. Install Node.js (for example with Homebrew) and try again.",
    );
  }
  const { host, port } = getBridgeEndpoint();
  const info = getRuntimePlatformInfo();
  const home = getRuntimeEnvValue("HOME");
  const environment = buildCodexLaunchEnvironment({
    ...(info.platform === "windows"
      ? {}
      : { PATH: await buildPosixLaunchPath(node, "node", info) }),
    ...(home ? { HOME: home } : {}),
  });
  const Subprocess = await CodexAppServerProcess.loadSubprocessModule();
  // The tsx CLI runs the script in a second node process, which a SIGKILL
  // of the CLI would orphan; its loader keeps the server in one process.
  return Subprocess.call({
    command: node,
    arguments: [
      "--import",
      toFileUrl(joinPath(adapterDir, TSX_LOADER_RELATIVE_PATH)),
      joinPath(adapterDir, BRIDGE_ENTRY_RELATIVE_PATH),
      "--host",
      host,
      "--port",
      port,
    ],
    workdir: adapterDir,
    stderr: "pipe",
    environment,
    environmentAppend: true,
  });
}

async function runStart(): Promise<BridgeState> {
  if (owned) return state;
  const startEpoch = epoch;
  const cancelled = () => epoch !== startEpoch;

  if (await isBridgeHealthy()) {
    if (!cancelled() && !owned)
      setState({ kind: "running", owner: "external" });
    return state;
  }
  if (cancelled()) return state;

  const adapterDir = getClaudeBridgeAdapterDir();
  const hint = await validateBridgeAdapterDir(adapterDir);
  if (cancelled()) return state;
  if (hint) {
    setState({ kind: "failed", reason: hint });
    return state;
  }
  let host: string;
  try {
    host = getBridgeEndpoint().host;
  } catch {
    setState({ kind: "failed", reason: "The bridge URL is not a valid URL." });
    return state;
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    setState({
      kind: "failed",
      reason: `The bridge URL points to ${host}. Zotero can only start a bridge on this computer.`,
    });
    return state;
  }

  setState({ kind: "starting" });
  let proc: BridgeSubprocess;
  try {
    proc = await spawnBridge(adapterDir);
  } catch (err) {
    if (!cancelled()) {
      setState({
        kind: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return state;
  }
  const child = adoptChild(proc);
  owned = child;
  if (cancelled()) {
    await terminate(child);
    return state;
  }

  const deadline = Date.now() + timing.startTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(timing.pollIntervalMs);
    if (owned !== child) return state;
    if (await isBridgeHealthy()) {
      if (owned !== child) return state;
      setState({ kind: "running", owner: "plugin" });
      return state;
    }
  }
  if (owned !== child) return state;
  await terminate(child);
  const tail = stderrTail(child);
  setState({
    kind: "failed",
    reason: `bridge did not answer /healthz within ${Math.round(timing.startTimeoutMs / 1000)} s${tail ? `: ${tail}` : ""}`,
  });
  return state;
}

export function getBridgeState(): BridgeState {
  return state;
}

export function subscribeBridgeState(listener: BridgeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Idempotent: concurrent calls share one attempt and spawn at most once. */
export function startBridge(): Promise<BridgeState> {
  if (!pendingStart) {
    pendingStart = runStart().finally(() => {
      pendingStart = null;
    });
  }
  return pendingStart;
}

/**
 * Only a child this plugin spawned is killed; an external bridge keeps
 * running. Bounded by the stop grace and cap, so shutdown never hangs on it.
 */
export async function stopBridge(): Promise<BridgeState> {
  if (!owned) {
    if (state.kind === "starting") {
      epoch += 1;
      setState({ kind: "stopped" });
    }
    return state;
  }
  epoch += 1;
  const child = owned;
  setState({ kind: "stopping" });
  await terminate(child);
  setState({ kind: "stopped" });
  return state;
}

/** Re-reads healthz for a bridge this plugin is not managing. */
export async function refreshBridgeState(): Promise<BridgeState> {
  if (owned || pendingStart || state.kind === "stopping") return state;
  const healthy = await isBridgeHealthy();
  if (owned || pendingStart) return state;
  if (healthy) {
    setState({ kind: "running", owner: "external" });
  } else if (state.kind === "running") {
    setState({ kind: "stopped" });
  }
  return state;
}

export function setBridgeTimingForTests(
  overrides: Partial<typeof DEFAULT_TIMING>,
): void {
  timing = { ...DEFAULT_TIMING, ...overrides };
}

export function resetBridgeProcessForTests(): void {
  timing = { ...DEFAULT_TIMING };
  state = { kind: "stopped" };
  owned = null;
  pendingStart = null;
  epoch = 0;
  listeners.clear();
}
