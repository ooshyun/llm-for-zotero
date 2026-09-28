import { assert } from "chai";
import {
  getBridgeState,
  resetBridgeProcessForTests,
  setBridgeTimingForTests,
  startBridge,
  stopBridge,
  subscribeBridgeState,
  type BridgeState,
} from "../src/claudeCode/bridgeProcess";
import { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";

const ADAPTER_DIR = "/Users/alice/cc-llm4zotero-adapter";
const NODE = "/opt/homebrew/bin/node";

type SubprocessCallOptions = {
  command: string;
  arguments: string[];
  workdir?: string;
  stderr?: string;
  environment?: Record<string, string>;
  environmentAppend?: boolean;
};

type FakeChild = {
  killCalls: Array<number | undefined>;
  exit: (exitCode: number) => void;
  stdout: { readString: () => Promise<string> };
  stderr: { readString: () => Promise<string> };
  kill: (timeoutMs?: number) => Promise<{ exitCode: number }>;
  wait: () => Promise<{ exitCode: number }>;
};

function createFakeChild(stderrChunks: string[] = []): FakeChild {
  let resolveExit!: (result: { exitCode: number }) => void;
  const exited = new Promise<{ exitCode: number }>((resolve) => {
    resolveExit = resolve;
  });
  const pendingStderr = [...stderrChunks];
  const child: FakeChild = {
    killCalls: [],
    exit: (exitCode) => resolveExit({ exitCode }),
    stdout: { readString: () => exited.then(() => "") },
    stderr: {
      readString: async () =>
        pendingStderr.length
          ? (pendingStderr.shift() as string)
          : exited.then(() => ""),
    },
    kill: (timeoutMs) => {
      child.killCalls.push(timeoutMs);
      resolveExit({ exitCode: -15 });
      return exited;
    },
    wait: () => exited,
  };
  return child;
}

function createNodeLookupProcess() {
  const chunks = [`${NODE}\n`];
  return {
    stdout: { readString: async () => chunks.shift() ?? "" },
    wait: async () => ({ exitCode: 0 }),
  };
}

type Harness = {
  spawnCalls: SubprocessCallOptions[];
  fetchCount: () => number;
  states: string[];
};

type TestGlobal = typeof globalThis & {
  fetch: typeof fetch;
  IOUtils?: unknown;
  Zotero?: unknown;
};

const originalLoadSubprocessModule = CodexAppServerProcess.loadSubprocessModule;
const originalFetch = globalThis.fetch;
const originalProcess = globalThis.process;

function describeState(next: BridgeState): string {
  if (next.kind === "running") return `running/${next.owner}`;
  if (next.kind === "failed") return `failed: ${next.reason}`;
  return next.kind;
}

function install(options: {
  healthByCall: boolean[];
  child?: FakeChild;
  onSpawn?: (child: FakeChild) => void;
}): Harness {
  const globals = globalThis as TestGlobal;
  const spawnCalls: SubprocessCallOptions[] = [];
  let fetchCalls = 0;

  globals.process = {
    ...originalProcess,
    env: { HOME: "/Users/alice", PATH: "/usr/bin:/bin" },
  } as typeof process;
  globals.Zotero = {
    isMac: true,
    Prefs: {
      get: (key: string) => {
        if (key.endsWith(".claudeBridgeAdapterDir")) return ADAPTER_DIR;
        if (key.endsWith(".agentBackendBridgeUrl")) {
          return "http://127.0.0.1:19787";
        }
        return undefined;
      },
      set: () => {},
    },
  };
  globals.IOUtils = {
    exists: async (path: string) =>
      path === `${ADAPTER_DIR}/bin/start-bridge-server.ts` ||
      path === `${ADAPTER_DIR}/node_modules/tsx/dist/loader.mjs` ||
      path === NODE,
  };
  globals.fetch = (async (url: string) => {
    const healthy =
      options.healthByCall[
        Math.min(fetchCalls, options.healthByCall.length - 1)
      ];
    fetchCalls += 1;
    assert.equal(url, "http://127.0.0.1:19787/healthz");
    if (!healthy) throw new TypeError("fetch failed: ECONNREFUSED");
    return {
      ok: true,
      json: async () => ({ ok: true, protocolVersion: 2 }),
    };
  }) as unknown as typeof fetch;
  CodexAppServerProcess.loadSubprocessModule = async () => ({
    call: async (call: SubprocessCallOptions) => {
      if (call.arguments.join(" ") === "-c which node") {
        return createNodeLookupProcess();
      }
      spawnCalls.push(call);
      const child = options.child ?? createFakeChild();
      options.onSpawn?.(child);
      return child;
    },
  });

  const states: string[] = [];
  subscribeBridgeState((next) => states.push(describeState(next)));
  return { spawnCalls, fetchCount: () => fetchCalls, states };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("claudeCode/bridgeProcess", function () {
  beforeEach(function () {
    setBridgeTimingForTests({
      pollIntervalMs: 5,
      startTimeoutMs: 400,
      stopCapMs: 100,
      stderrTailWaitMs: 20,
    });
  });

  afterEach(function () {
    resetBridgeProcessForTests();
    CodexAppServerProcess.loadSubprocessModule = originalLoadSubprocessModule;
    const globals = globalThis as TestGlobal;
    globals.fetch = originalFetch;
    globals.process = originalProcess;
    delete globals.IOUtils;
    delete globals.Zotero;
  });

  it("adopts a bridge that already answers healthz without spawning", async function () {
    const harness = install({ healthByCall: [true] });

    const result = await startBridge();

    assert.deepEqual(result, { kind: "running", owner: "external" });
    assert.deepEqual(harness.spawnCalls, []);
    assert.deepEqual(harness.states, ["running/external"]);
  });

  it("spawns node with the tsx loader and becomes plugin-owned once healthz answers", async function () {
    const harness = install({ healthByCall: [false, false, false, true] });

    const result = await startBridge();

    assert.deepEqual(result, { kind: "running", owner: "plugin" });
    assert.equal(harness.fetchCount(), 4);
    assert.deepEqual(harness.states, ["starting", "running/plugin"]);
    assert.deepEqual(harness.spawnCalls, [
      {
        command: NODE,
        arguments: [
          "--import",
          `file://${ADAPTER_DIR}/node_modules/tsx/dist/loader.mjs`,
          `${ADAPTER_DIR}/bin/start-bridge-server.ts`,
          "--host",
          "127.0.0.1",
          "--port",
          "19787",
        ],
        workdir: ADAPTER_DIR,
        stderr: "pipe",
        environment: {
          PATH: [
            "/opt/homebrew/bin",
            "/Users/alice/.cargo/bin",
            "/Users/alice/.npm-global/bin",
            "/Users/alice/.local/bin",
            "/Users/alice/.volta/bin",
            "/Users/alice/.asdf/shims",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
          ].join(":"),
          HOME: "/Users/alice",
          NO_PROXY: "localhost,127.0.0.1,::1",
          no_proxy: "localhost,127.0.0.1,::1",
        },
        environmentAppend: true,
      },
    ]);
  });

  it("fails with the stderr tail when the child exits before it is healthy", async function () {
    const child = createFakeChild([
      "node:events:502\n",
      "Error: listen EADDRINUSE: address already in use 127.0.0.1:19787\n",
    ]);
    install({
      healthByCall: [false],
      child,
      onSpawn: (spawned) => setTimeout(() => spawned.exit(1), 10),
    });

    const result = await startBridge();

    assert.deepEqual(result, {
      kind: "failed",
      reason:
        "bridge exited with code 1: node:events:502\nError: listen EADDRINUSE: address already in use 127.0.0.1:19787",
    });
    assert.deepEqual(child.killCalls, []);
  });

  it("fails with the stderr tail when a running child exits unexpectedly", async function () {
    const child = createFakeChild(["FATAL: bridge crashed\n"]);
    const harness = install({ healthByCall: [false, true], child });

    await startBridge();
    child.exit(3);
    await sleep(50);

    assert.deepEqual(getBridgeState(), {
      kind: "failed",
      reason: "bridge exited with code 3: FATAL: bridge crashed",
    });
    assert.deepEqual(harness.states, [
      "starting",
      "running/plugin",
      "failed: bridge exited with code 3: FATAL: bridge crashed",
    ]);
  });

  it("kills and fails a child that never answers healthz, keeping the last 300 characters of stderr", async function () {
    const noisyLine = `${"x".repeat(200)}\n`;
    const child = createFakeChild([noisyLine, noisyLine, "last line\n"]);
    install({ healthByCall: [false], child });
    setBridgeTimingForTests({
      pollIntervalMs: 5,
      startTimeoutMs: 60,
      stopCapMs: 100,
      stderrTailWaitMs: 20,
    });

    const result = await startBridge();

    assert.deepEqual(child.killCalls, [2000]);
    assert.deepEqual(result, {
      kind: "failed",
      reason: `bridge did not answer /healthz within 0 s: …${`${"x".repeat(200)}\n${"x".repeat(200)}\nlast line`.slice(-300)}`,
    });
  });

  it("stops a plugin-owned bridge by killing its child", async function () {
    const child = createFakeChild();
    const harness = install({ healthByCall: [false, true], child });
    await startBridge();

    const result = await stopBridge();

    assert.deepEqual(child.killCalls, [2000]);
    assert.deepEqual(result, { kind: "stopped" });
    assert.deepEqual(harness.states, [
      "starting",
      "running/plugin",
      "stopping",
      "stopped",
    ]);
  });

  it("cancels a start that is still waiting for healthz when stopped", async function () {
    const child = createFakeChild();
    const harness = install({ healthByCall: [false], child });

    const starting = startBridge();
    await sleep(20);
    const stopped = await stopBridge();
    const started = await starting;

    assert.deepEqual(child.killCalls, [2000]);
    assert.deepEqual(stopped, { kind: "stopped" });
    assert.deepEqual(started, { kind: "stopped" });
    assert.deepEqual(harness.states, ["starting", "stopping", "stopped"]);
  });

  it("leaves an external bridge running on stop", async function () {
    const harness = install({ healthByCall: [true] });
    await startBridge();

    const result = await stopBridge();

    assert.deepEqual(result, { kind: "running", owner: "external" });
    assert.deepEqual(harness.spawnCalls, []);
    assert.deepEqual(harness.states, ["running/external"]);
  });

  it("spawns once when started twice concurrently", async function () {
    const harness = install({ healthByCall: [false, false, true] });

    const results = await Promise.all([startBridge(), startBridge()]);

    assert.deepEqual(results, [
      { kind: "running", owner: "plugin" },
      { kind: "running", owner: "plugin" },
    ]);
    assert.lengthOf(harness.spawnCalls, 1);
  });
});
