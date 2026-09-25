import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeLog } from "./bridge-log";

async function temporaryLog(
  options: Readonly<{ maxBytes?: number; onError?: (error: Error) => void }> = {},
): Promise<{ file: string; log: BridgeLog; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "roqer-bridge-log-"));
  const file = join(root, "nested", "bridge.log");
  let tick = 0;
  return {
    file,
    log: new BridgeLog(file, {
      ...options,
      now: () => new Date(Date.UTC(2026, 8, 13, 16, 41, 16, tick++)),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("lines land stamped, in order, in a folder that did not exist", async () => {
  const fixture = await temporaryLog();
  try {
    await fixture.log.write("[roqer] bridge starting");
    await fixture.log.write("HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)");
    await fixture.log.write("[roqer] The bridge exited with code 1.");

    assert.equal(await readFile(fixture.file, "utf8"), [
      "2026-09-13T16:41:16.000Z [roqer] bridge starting",
      "2026-09-13T16:41:16.001Z HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)",
      "2026-09-13T16:41:16.002Z [roqer] The bridge exited with code 1.",
      "",
    ].join("\n"));
  } finally {
    await fixture.cleanup();
  }
});

test("a log left by the last session is appended to, not replaced", async () => {
  const fixture = await temporaryLog();
  try {
    await fixture.log.write("first session");
    const again = new BridgeLog(fixture.file, { now: () => new Date("2026-09-14T09:00:00.000Z") });
    await again.write("second session");
    assert.deepEqual((await again.text()).split("\n").filter((line) => line.length > 0), [
      "2026-09-13T16:41:16.000Z first session",
      "2026-09-14T09:00:00.000Z second session",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("the oldest lines go once the file passes its cap, and the newest always stays", async () => {
  const fixture = await temporaryLog({ maxBytes: 600 });
  try {
    // Each line is a little over sixty bytes with its stamp, so the cap holds
    // about nine, and a trim leaves about four.
    for (let index = 0; index < 40; index += 1) {
      await fixture.log.write(`line ${String(index).padStart(2, "0")} ${"x".repeat(30)}`);
    }
    const lines = (await fixture.log.text()).split("\n").filter((line) => line.length > 0);
    assert.ok(lines.length < 12, `expected the file to be trimmed, got ${lines.length} lines`);
    assert.match(lines.at(-1) ?? "", /line 39 /);
    assert.ok(Buffer.byteLength(await fixture.log.text(), "utf8") <= 600);

    // A line larger than the whole cap survives on its own.
    await fixture.log.write("y".repeat(2_000));
    const after = (await fixture.log.text()).split("\n").filter((line) => line.length > 0);
    assert.equal(after.length, 1);
    assert.match(after[0] ?? "", /y{2000}$/);
  } finally {
    await fixture.cleanup();
  }
});

test("a write that fails is reported and the next one still lands", async () => {
  const errors: Error[] = [];
  const fixture = await temporaryLog({ onError: (error) => errors.push(error) });
  try {
    // A directory where the file should be: the append cannot succeed.
    await writeFile(join(fixture.file, "..", "..", "placeholder"), "");
    const blocked = new BridgeLog(join(fixture.file, "..", "..", "placeholder", "bridge.log"), {
      onError: (error) => errors.push(error),
    });
    await blocked.write("nowhere to go");
    assert.equal(errors.length, 1);

    await fixture.log.write("still fine");
    assert.match(await fixture.log.text(), /still fine/);
  } finally {
    await fixture.cleanup();
  }
});
