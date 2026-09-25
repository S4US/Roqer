import assert from "node:assert/strict";
import test from "node:test";

import {
  McpServerProcess,
  MAX_START_ATTEMPTS,
  HEALTHY_RUN_MS,
  PLUGIN_PROBLEM_MARKER,
  STUDIO_RESTART_MARKER,
  type McpServerProcessOptions,
} from "./mcp-server-process";
import type { McpServerState } from "../shared/mcp-server";
import { FakeChildProcess } from "./test-child-process";

const ENDPOINT = "http://127.0.0.1:58741";

/**
 * Time is synthetic so the real timeouts are exercised instantly, but each
 * simulated wait still yields to the event loop. Without that, a spawned
 * process's own "data" and "exit" events would never get a turn to run, and the
 * test would be measuring a starved queue rather than the supervisor.
 */
function fakeClock(start = 1_000) {
  let clock = start;
  return {
    now: () => clock,
    delay: async (ms = 0): Promise<void> => {
      clock += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    advance: (ms: number) => { clock += ms; },
  };
}

/** Let the fake process's deferred exit and output events run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * A clock whose waits yield long enough for a fake process to exit.
 *
 * `fakeClock` resolves on the next immediate, which is sooner than a
 * FakeChildProcess delivers its own "exit", so a test using it would measure
 * the timeout every time rather than the case it means to describe. The wait is
 * long enough that a loaded machine does not turn the difference into a flake.
 */
function patientClock(start = 1_000) {
  let clock = start;
  return {
    now: () => clock,
    delay: async (ms = 0): Promise<void> => {
      clock += ms;
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}

/** A supervisor wired to fakes, with the clock under the test's control. */
function harness(options: Omit<Partial<McpServerProcessOptions>, "spawnServer"> & {
  spawnServer: () => FakeChildProcess;
}) {
  const states: McpServerState[] = [];
  const spawned: FakeChildProcess[] = [];
  const clock = fakeClock();
  let healthy = false;

  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: options.probe ?? (async () => healthy),
    spawnServer: () => {
      const child = options.spawnServer();
      spawned.push(child);
      return child.asChild();
    },
    onState: (state) => states.push(state),
    delay: clock.delay,
    now: clock.now,
  });

  return {
    server,
    states,
    spawned,
    clock,
    setHealthy: (value: boolean) => { healthy = value; },
  };
}

/** A supervisor whose bridge starts answering as soon as it is spawned. */
function healthyHarness(makeChild: () => FakeChildProcess = () => new FakeChildProcess()) {
  const clock = fakeClock();
  const children: FakeChildProcess[] = [];
  let healthy = false;
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: async () => healthy,
    spawnServer: () => {
      const child = makeChild();
      children.push(child);
      healthy = true;
      return child.asChild();
    },
    delay: clock.delay,
    now: clock.now,
  });
  return { server, children, clock, setHealthy: (value: boolean) => { healthy = value; } };
}

/**
 * A process that takes its time dying: `kill` is noted but the exit only
 * arrives when the test delivers it, as a real process's can arrive after the
 * supervisor has already moved on.
 */
class LingeringChildProcess extends FakeChildProcess {
  override kill(): boolean {
    this.killed = true;
    return true;
  }
}

test("a bridge that is already listening is adopted, not replaced", async () => {
  const bench = harness({ spawnServer: () => new FakeChildProcess() });
  bench.setHealthy(true);

  const state = await bench.server.start();
  assert.deepEqual(state, { kind: "adopted", endpoint: ENDPOINT });
  // Someone else's session must survive Roqer starting up.
  assert.equal(bench.spawned.length, 0);
});

test("adopting somebody else's bridge still installs the Studio plugin", async () => {
  const clock = patientClock();
  const installers: FakeChildProcess[] = [];
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: async () => true,
    spawnServer: () => { throw new Error("an adopted bridge must not be replaced"); },
    installPlugin: () => {
      const child = new FakeChildProcess();
      installers.push(child);
      setImmediate(() => {
        child.stderr.write(`${STUDIO_RESTART_MARKER}\n`);
        child.finish(0);
      });
      return child.asChild();
    },
    delay: clock.delay,
    now: clock.now,
  });

  // The adopted bridge belongs to someone else and may never have installed
  // the plugin, which used to leave the app with no way to reach Studio.
  const state = await server.start();
  assert.equal(installers.length, 1);
  assert.deepEqual(state, { kind: "adopted", endpoint: ENDPOINT, pluginUpdated: true });
});

test("an install that fails is reported rather than leaving Studio silently unreachable", async () => {
  const clock = patientClock();
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: async () => true,
    spawnServer: () => { throw new Error("an adopted bridge must not be replaced"); },
    installPlugin: () => {
      const child = new FakeChildProcess();
      setImmediate(() => {
        child.stderr.write(`${PLUGIN_PROBLEM_MARKER} Bundled MCPPlugin.rbxmx not found.\n`);
        child.finish(1);
      });
      return child.asChild();
    },
    delay: clock.delay,
    now: clock.now,
  });

  const state = await server.start();
  assert.deepEqual(state, {
    kind: "adopted",
    endpoint: ENDPOINT,
    pluginProblem: "Bundled MCPPlugin.rbxmx not found.",
  });
});

test("an installer that never exits is abandoned instead of holding up startup", async () => {
  const clock = fakeClock();
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: async () => true,
    spawnServer: () => { throw new Error("an adopted bridge must not be replaced"); },
    // Spawned and then silent: no output, no exit.
    installPlugin: () => new FakeChildProcess().asChild(),
    delay: clock.delay,
    now: clock.now,
  });

  const state = await server.start();
  assert.equal(state.kind, "adopted");
  if (state.kind === "adopted") assert.match(state.pluginProblem ?? "", /took too long/);
});

test("a bridge Roqer starts itself needs no separate installer", async () => {
  const clock = fakeClock();
  let installers = 0;
  let healthy = false;
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: async () => healthy,
    spawnServer: () => {
      healthy = true;
      return new FakeChildProcess().asChild();
    },
    installPlugin: () => { installers += 1; return new FakeChildProcess().asChild(); },
    delay: clock.delay,
    now: clock.now,
  });

  assert.deepEqual(await server.start(), { kind: "running", endpoint: ENDPOINT });
  // `--auto-install-plugin` is part of the bridge's own launch, so running the
  // installer again would be a second install for no reason.
  assert.equal(installers, 0);
});

test("a spawned bridge becomes running once it answers", async () => {
  const clock = fakeClock();
  const spawned: FakeChildProcess[] = [];
  let probes = 0;
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    // Not listening at first, so it is spawned; healthy from the third probe.
    probe: async () => { probes += 1; return probes > 2; },
    spawnServer: () => {
      const child = new FakeChildProcess();
      spawned.push(child);
      return child.asChild();
    },
    delay: clock.delay,
    now: clock.now,
  });

  assert.deepEqual(await server.start(), { kind: "running", endpoint: ENDPOINT });
  assert.equal(spawned.length, 1);
});

test("a launch that replaced the Studio plugin reports it, so an open Studio can be restarted", async () => {
  const clock = fakeClock();
  let probes = 0;
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    // Nothing is listening at first, so a bridge is spawned; it answers once
    // its own startup work — including the plugin install — is done.
    probe: async () => { probes += 1; return probes > 2; },
    spawnServer: () => {
      const child = new FakeChildProcess();
      child.stderr.write(`[install-plugin] Installed MCPPlugin.rbxmx to C:\\Plugins\n${STUDIO_RESTART_MARKER}\n`);
      return child.asChild();
    },
    delay: clock.delay,
    now: clock.now,
  });

  assert.deepEqual(await server.start(), { kind: "running", endpoint: ENDPOINT, pluginUpdated: true });
});

test("a plugin install reported after the bridge answers still reaches the interface", async () => {
  const bench = healthyHarness();
  assert.deepEqual(await bench.server.start(), { kind: "running", endpoint: ENDPOINT });

  // Output arrives on its own schedule, so the marker can land after the probe
  // has already succeeded. Leaving the state alone would lose the notice.
  bench.children[0].stderr.write(`${STUDIO_RESTART_MARKER}\n`);
  await settle();
  assert.deepEqual(bench.server.state, { kind: "running", endpoint: ENDPOINT, pluginUpdated: true });
});

test("an unchanged plugin says nothing, because there is nothing to restart for", async () => {
  const bench = healthyHarness();
  assert.deepEqual(await bench.server.start(), { kind: "running", endpoint: ENDPOINT });
  bench.children[0].stderr.write("[install-plugin] MCPPlugin.rbxmx already installed.\n");
  await settle();
  assert.deepEqual(bench.server.state, { kind: "running", endpoint: ENDPOINT });
});

test("a bridge that dies during startup is retried, then reported with its own output", async () => {
  const children: FakeChildProcess[] = [];
  const bench = harness({
    spawnServer: () => {
      const child = new FakeChildProcess();
      children.push(child);
      // Fail the way a real bridge does: complain on stderr, then exit.
      setImmediate(() => {
        child.stderr.write("Error: listen EADDRINUSE 127.0.0.1:58741\n");
        child.finish(1);
      });
      return child;
    },
  });

  const state = await bench.server.start();
  assert.equal(state.kind, "failed");
  assert.equal(children.length, MAX_START_ATTEMPTS);
  if (state.kind === "failed") {
    assert.match(state.message, new RegExp(`after ${MAX_START_ATTEMPTS} attempts`));
    // The reason a person needs is what the process itself said.
    assert.match(state.detail ?? "", /EADDRINUSE/);
  }
});

test("a bridge that never answers is given up on rather than spun on forever", async () => {
  const bench = harness({ spawnServer: () => new FakeChildProcess() });
  const state = await bench.server.start();
  assert.equal(state.kind, "failed");
  if (state.kind === "failed") assert.match(state.message, /could not be started/);
  // Every attempt's process is killed rather than left running.
  assert.equal(bench.spawned.every((child) => child.killed), true);
});

test("a bridge that dies after running is restarted on its own", async () => {
  const bench = healthyHarness();

  assert.deepEqual(await bench.server.start(), { kind: "running", endpoint: ENDPOINT });
  assert.equal(bench.children.length, 1);

  bench.setHealthy(false);
  bench.children[0].finish(1);
  await settle();
  assert.equal(bench.children.length, 2, "the supervisor should have started a replacement");
  assert.deepEqual(bench.server.state, { kind: "running", endpoint: ENDPOINT });
});

test("a long healthy run earns a fresh restart budget", async () => {
  const bench = healthyHarness();
  await bench.server.start();

  // A crash after a long, healthy run is not evidence of a broken install, so
  // it must not consume the budget meant for a failing start.
  bench.clock.advance(HEALTHY_RUN_MS * 2);
  bench.setHealthy(false);
  bench.children[0].finish(1);
  await settle();
  assert.equal(bench.server.state.kind, "running");
});

test("stopping closes stdin first, and an adopted bridge is left alone", async () => {
  const bench = healthyHarness();
  await bench.server.start();

  let stdinEnded = false;
  bench.children[0].stdin.on("finish", () => { stdinEnded = true; });
  const stopping = bench.server.stop();
  bench.children[0].finish(0);
  await stopping;
  // Closing stdin is the bridge's own shutdown path; a signal is the fallback.
  assert.equal(stdinEnded, true);
  assert.deepEqual(bench.server.state, { kind: "stopped" });

  const clock = fakeClock();
  const adopted = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: async () => true,
    spawnServer: () => { throw new Error("an adopted bridge must never be spawned over"); },
    delay: clock.delay,
    now: clock.now,
  });
  await adopted.start();
  await adopted.stop();
  // Roqer did not start it, so quitting Roqer must not stop it.
  assert.deepEqual(adopted.state, { kind: "adopted", endpoint: ENDPOINT });
});

test("a stopped supervisor does not keep restarting the bridge", async () => {
  const bench = healthyHarness();
  await bench.server.start();
  const stopping = bench.server.stop();
  bench.children[0].finish(0);
  await stopping;
  await settle();
  assert.equal(bench.children.length, 1, "a deliberate stop is not a crash to recover from");
});

test("a bridge that cannot be spawned at all fails with the reason", async () => {
  const clock = fakeClock();
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: async () => false,
    spawnServer: () => { throw new Error("spawn ENOENT"); },
    delay: clock.delay,
    now: clock.now,
  });
  const state = await server.start();
  assert.equal(state.kind, "failed");
  if (state.kind === "failed") assert.match(state.message, /spawn ENOENT/);
});

test("concurrent starts share one attempt instead of racing for the port", async () => {
  const bench = healthyHarness();
  const [first, second] = await Promise.all([bench.server.start(), bench.server.start()]);
  assert.deepEqual(first, second);
  assert.equal(bench.children.length, 1);
});

test("an adopted bridge that goes away is replaced with one of Roqer's own when a run asks", async () => {
  const clock = fakeClock();
  const children: FakeChildProcess[] = [];
  // Somebody else's bridge answers at first, then stops.
  let theirs = true;
  let ours = false;
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: async () => theirs || ours,
    spawnServer: () => {
      const child = new FakeChildProcess();
      children.push(child);
      ours = true;
      return child.asChild();
    },
    delay: clock.delay,
    now: clock.now,
  });
  assert.deepEqual(await server.start(), { kind: "adopted", endpoint: ENDPOINT });

  // Nothing here holds a process for it, so nothing notices on its own: the
  // state went on saying "adopted" for the rest of the session while every
  // tool call failed. A run that finds the endpoint dead asks, and gets a
  // bridge back.
  theirs = false;
  const recovery = await server.recover();
  assert.equal(recovery.restarted, true);
  assert.deepEqual(recovery.state, { kind: "running", endpoint: ENDPOINT });
  assert.equal(children.length, 1);
});

test("recovery leaves a bridge that answers alone", async () => {
  const bench = healthyHarness();
  await bench.server.start();

  // One refused connection while the bridge was busy is not a dead bridge.
  const recovery = await bench.server.recover();
  assert.deepEqual(recovery, { state: { kind: "running", endpoint: ENDPOINT }, restarted: false });
  assert.equal(bench.children.length, 1);
});

test("recovery waits for a restart the supervisor already began", async () => {
  const clock = fakeClock();
  const children: FakeChildProcess[] = [];
  let healthy = false;
  // Once armed, every probe waits until the test lets it through, which holds
  // the restart open long enough to ask about it.
  let gated = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: async () => {
      if (gated) await gate;
      return healthy;
    },
    spawnServer: () => {
      const child = new FakeChildProcess();
      children.push(child);
      healthy = true;
      return child.asChild();
    },
    delay: clock.delay,
    now: clock.now,
  });
  await server.start();

  gated = true;
  healthy = false;
  children[0].finish(1);
  await settle();
  // The exit was seen and a replacement is on its way. Asking now must join
  // that restart, not spawn a third bridge over it.
  const recovering = server.recover();
  release();
  const recovery = await recovering;
  assert.equal(recovery.restarted, true);
  assert.deepEqual(recovery.state, { kind: "running", endpoint: ENDPOINT });
  assert.equal(children.length, 2);
});

test("a bridge that stopped listening without exiting is stopped and replaced", async () => {
  const bench = healthyHarness(() => new LingeringChildProcess());
  await bench.server.start();

  // Alive, answering nothing.
  bench.setHealthy(false);
  const recovery = await bench.server.recover();
  assert.equal(recovery.restarted, true);
  assert.equal(bench.children[0].killed, true, "the silent bridge must not be left to contend for the port");
  assert.equal(bench.children.length, 2);
  assert.deepEqual(bench.server.state, { kind: "running", endpoint: ENDPOINT });
});

test("a replaced bridge exiting late does not start a second recovery over its replacement", async () => {
  const bench = healthyHarness(() => new LingeringChildProcess());
  await bench.server.start();

  bench.setHealthy(false);
  await bench.server.recover();
  assert.equal(bench.children.length, 2);

  // The first bridge's exit arrives after its replacement is already running.
  // Reacting to it would probe, find the replacement answering, and record
  // Roqer's own bridge as somebody else's.
  bench.children[0].finish(1);
  await settle();
  assert.deepEqual(bench.server.state, { kind: "running", endpoint: ENDPOINT });
  assert.equal(bench.children.length, 2);
});

test("a stopped supervisor is not brought back by recovery", async () => {
  const bench = healthyHarness();
  await bench.server.start();
  const stopping = bench.server.stop();
  bench.children[0].finish(0);
  await stopping;

  bench.setHealthy(false);
  const recovery = await bench.server.recover();
  assert.deepEqual(recovery, { state: { kind: "stopped" }, restarted: false });
  assert.equal(bench.children.length, 1);
});

test("every line the bridge writes, and every step the supervisor takes, reaches the log", async () => {
  const clock = fakeClock();
  const lines: string[] = [];
  const children: FakeChildProcess[] = [];
  let healthy = false;
  const server = new McpServerProcess({
    endpoint: ENDPOINT,
    probe: async () => healthy,
    spawnServer: () => {
      const child = new FakeChildProcess();
      children.push(child);
      healthy = true;
      return child.asChild();
    },
    onOutput: (line) => {
      lines.push(line);
      // A sink that throws must not take the supervisor with it.
      if (line.includes("throw")) throw new Error("disk full");
    },
    delay: clock.delay,
    now: clock.now,
  });

  await server.start();
  children[0].stderr.write("HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)\nplease throw\n");
  await settle();
  healthy = false;
  children[0].finish(1);
  await settle();

  // What the process said, in order, with the supervisor's own account of
  // what it did around it. This is what a person reads after the bridge died
  // an hour into a session and the process is no longer there to ask.
  assert.deepEqual(lines, [
    "[roqer] bridge starting",
    "[roqer] bridge running at http://127.0.0.1:58741",
    "HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)",
    "please throw",
    "[roqer] The bridge exited with code 1.",
    "[roqer] the bridge stopped unexpectedly; restarting it",
    "[roqer] bridge starting",
    "[roqer] bridge running at http://127.0.0.1:58741",
  ]);
  assert.equal(server.state.kind, "running");
});
