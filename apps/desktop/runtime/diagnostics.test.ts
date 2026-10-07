import assert from "node:assert/strict";
import test from "node:test";

import { composeDiagnostics, DIAGNOSTICS_LOG_LINES, logTail, redactHome, type DiagnosticsFacts } from "./diagnostics";

const HOME = "C:\\Users\\Ada";

function facts(overrides: Partial<DiagnosticsFacts> = {}): DiagnosticsFacts {
  return {
    generatedAt: new Date(Date.UTC(2026, 9, 6, 18, 3, 48)),
    appVersion: "0.1.11",
    packaged: true,
    system: "win32 10.0.26200 x64",
    versions: { electron: "38.1.0", chrome: "140.0", node: "22.19.0" },
    bridge: { kind: "running", endpoint: "http://127.0.0.1:58741" },
    studio: {
      kind: "bridge-only",
      endpoint: "http://127.0.0.1:58741",
      serverVersion: "3.0.3",
      message: "Waiting for Roblox Studio",
      instances: [],
    },
    bridgeLog: [
      "2026-10-06T18:03:49.608Z Auth token loaded from C:\\Users\\Ada\\.robloxstudio-mcp\\auth-token",
      "2026-10-06T18:03:49.633Z Waiting for Studio plugin to connect...",
      "",
    ].join("\n"),
    home: HOME,
    ...overrides,
  };
}

test("a report names the version, the bridge, what it saw of Studio, and the log", () => {
  const report = composeDiagnostics(facts());

  assert.match(report, /^Roqer diagnostics, 2026-10-06T18:03:48\.000Z\n/);
  assert.match(report, /\nRoqer 0\.1\.11 \(installed\) on win32 10\.0\.26200 x64\n/);
  assert.match(report, /\nElectron 38\.1\.0 · Chrome 140\.0 · Node 22\.19\.0\n/);
  assert.match(report, /\nStudio bridge: running at http:\/\/127\.0\.0\.1:58741\n/);
  assert.match(report, /\nStudio: Waiting for Roblox Studio \(bridge-only\) at http:\/\/127\.0\.0\.1:58741, bridge version 3\.0\.3\n/);
  assert.match(report, /\nSessions: none\n/);
  assert.match(report, /\nbridge\.log:\n```text\n.*Waiting for Studio plugin to connect\.\.\.\n```\n$/s);
});

test("the home folder never reaches the report, so the account name does not either", () => {
  const report = composeDiagnostics(facts());

  assert.doesNotMatch(report, /Ada/);
  assert.match(report, /Auth token loaded from ~\\\.robloxstudio-mcp\\auth-token/);
});

test("place names stay out; each session is named by its role", () => {
  const report = composeDiagnostics(facts({
    studio: {
      kind: "connected",
      endpoint: "http://127.0.0.1:58741",
      placeName: "Secret Project",
      message: "Studio connected",
      instances: [
        { instanceId: "a", role: "edit", placeName: "Secret Project", isRunning: true },
        { instanceId: "b", role: "server", placeName: "Secret Project", isRunning: true },
        { instanceId: "c", role: "client-1", placeName: "Secret Project", isRunning: false },
      ],
    },
  }));

  assert.doesNotMatch(report, /Secret Project/);
  assert.match(report, /\nSessions: edit \(playing\), server \(playing\), client-1\n/);
});

test("a failed bridge carries its last words, and a plugin problem is spelled out", () => {
  const failed = composeDiagnostics(facts({
    bridge: { kind: "failed", message: "The Studio bridge could not be started after 4 attempts.", detail: "Port 58741 in use - entering proxy mode\n" },
  }));
  assert.match(failed, /\nStudio bridge: failed: The Studio bridge could not be started after 4 attempts\.\n/);
  assert.match(failed, /\nWhat the bridge last said before it failed:\n```text\nPort 58741 in use - entering proxy mode\n```\n/);

  const problem = composeDiagnostics(facts({
    bridge: { kind: "adopted", endpoint: "http://127.0.0.1:58741", pluginProblem: "Access is denied." },
  }));
  assert.match(problem, /\nStudio bridge: adopted \(started outside Roqer\) at http:\/\/127\.0\.0\.1:58741\n/);
  assert.match(problem, /\nStudio plugin: not installed: Access is denied\.\n/);
});

test("an empty log is said to be empty rather than shown as an empty block", () => {
  const report = composeDiagnostics(facts({ bridgeLog: "" }));

  assert.match(report, /\nbridge\.log is empty or could not be read\.\n$/);
  assert.doesNotMatch(report, /```/);
});

test("only the end of a long log is kept, and the heading says so", () => {
  const log = Array.from({ length: DIAGNOSTICS_LOG_LINES + 50 }, (_, index) => `line ${index}`).join("\n");
  const report = composeDiagnostics(facts({ bridgeLog: log }));

  assert.match(report, new RegExp(`\\nThe last ${DIAGNOSTICS_LOG_LINES} lines of bridge\\.log:\\n`));
  assert.doesNotMatch(report, /\nline 49\n/);
  assert.match(report, /\nline 50\n/);
  assert.match(report, new RegExp(`\\nline ${DIAGNOSTICS_LOG_LINES + 49}\\n`));
});

test("a log line with backticks cannot close the block it is in", () => {
  const report = composeDiagnostics(facts({ bridgeLog: "a ``` b\nc" }));

  assert.match(report, /\n````text\na ``` b\nc\n````\n$/);
});

test("the tail drops whole lines from the front to fit, and always keeps the newest", () => {
  assert.deepEqual(logTail("one\ntwo\nthree\n", 2, 1_000), { text: "two\nthree", lines: 2, omitted: true });
  assert.deepEqual(logTail("one\r\ntwo\r\n", 5, 1_000), { text: "one\ntwo", lines: 2, omitted: false });
  assert.deepEqual(logTail("aaaa\nbbbb\ncccc", 10, 10), { text: "bbbb\ncccc", lines: 2, omitted: true });
  assert.deepEqual(logTail("a very long newest line", 10, 4), { text: "a very long newest line", lines: 1, omitted: false });
  assert.deepEqual(logTail("", 10, 10), { text: "", lines: 0, omitted: false });
});

test("the home folder is found in every spelling a log uses, and only as a whole folder", () => {
  assert.equal(redactHome("C:\\Users\\Ada\\AppData", HOME), "~\\AppData");
  assert.equal(redactHome("c:/users/ada/AppData", HOME), "~/AppData");
  assert.equal(redactHome("{\"path\":\"C:\\\\Users\\\\Ada\\\\AppData\"}", HOME), "{\"path\":\"~\\\\AppData\"}");
  assert.equal(redactHome("C:\\Users\\Adam\\AppData", HOME), "C:\\Users\\Adam\\AppData");
  assert.equal(redactHome("C:\\Users\\Ada", `${HOME}\\`), "~");
  assert.equal(redactHome("anything", ""), "anything");
});
