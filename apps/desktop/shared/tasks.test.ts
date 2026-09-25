import assert from "node:assert/strict";
import test from "node:test";
import {
  isRunTaskList, parseRunTaskList, summarizeTasks, unfinishedTasks,
  MAX_RUN_TASKS, MAX_TASK_TITLE_CHARS, type RunTask,
} from "./tasks";

function task(overrides: Partial<RunTask> = {}): RunTask {
  return {
    id: "t1",
    title: "Read the coin service",
    status: "pending",
    requiresRuntimeEvidence: false,
    ...overrides,
  };
}

test("a well-formed list parses and trims its titles", () => {
  const tasks = parseRunTaskList({
    tasks: [
      { id: "a", title: "  Read the script  ", status: "done", requiredEvidence: [] },
      { id: "b", title: "Playtest the fix", status: "active", requiredEvidence: ["runtime", "interaction"] },
    ],
  });

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, "Read the script");
  assert.equal(tasks[1].requiresRuntimeEvidence, true);
  assert.deepEqual(tasks[1].requiredEvidence, ["runtime", "interaction"]);
});

test("a task list must be an array of objects with every field", () => {
  assert.throws(() => parseRunTaskList({}), /requires a `tasks` array/);
  assert.throws(() => parseRunTaskList({ tasks: [] }), /cannot be empty/);
  assert.throws(() => parseRunTaskList({ tasks: ["nope"] }), /Task 1 is not an object/);
  assert.throws(
    () => parseRunTaskList({ tasks: [{ id: "a", title: "x", status: "done" }] }),
    /requiredEvidence/,
    "the evidence promise is required, not inferred",
  );
  assert.throws(
    () => parseRunTaskList({ tasks: [{ id: "a", title: "x", status: "done", requiredEvidence: ["audio"] }] }),
    /runtime, visual, or interaction/,
  );
  assert.throws(
    () => parseRunTaskList({ tasks: [{ id: "a", title: "x", status: "done", requiredEvidence: ["visual", "visual"] }] }),
    /repeats an entry/,
  );
  assert.throws(
    () => parseRunTaskList({ tasks: [{ id: "a", title: "x", status: "wip", requiresRuntimeEvidence: false }] }),
    /needs a `status`/,
  );
});

test("ids must be unique so a status change is not read as a new task", () => {
  assert.throws(() => parseRunTaskList({
    tasks: [
      { id: "same", title: "One", status: "done", requiresRuntimeEvidence: false },
      { id: "same", title: "Two", status: "pending", requiresRuntimeEvidence: false },
    ],
  }), /repeats the id "same"/);
});

test("only one task may be active at a time", () => {
  assert.throws(() => parseRunTaskList({
    tasks: [
      { id: "a", title: "One", status: "active", requiresRuntimeEvidence: false },
      { id: "b", title: "Two", status: "active", requiresRuntimeEvidence: false },
    ],
  }), /Only one task may be "active"/);
});

test("the list is bounded in length and title size", () => {
  const many = Array.from({ length: MAX_RUN_TASKS + 1 }, (_, index) => ({
    id: `t${index}`, title: "x", status: "pending", requiresRuntimeEvidence: false,
  }));
  assert.throws(() => parseRunTaskList({ tasks: many }), /at most 12 tasks/);

  assert.throws(() => parseRunTaskList({
    tasks: [{ id: "a", title: "x".repeat(MAX_TASK_TITLE_CHARS + 1), status: "pending", requiresRuntimeEvidence: false }],
  }), /needs a `title`/);
});

test("isRunTaskList enforces the same cross-task rules as the parser", () => {
  assert.equal(isRunTaskList([task()]), true);
  assert.equal(isRunTaskList("not a list"), false);
  assert.equal(isRunTaskList([task({ id: "a" }), task({ id: "a" })]), false, "duplicate ids");
  assert.equal(
    isRunTaskList([task({ id: "a", status: "active" }), task({ id: "b", status: "active" })]),
    false,
    "two active tasks",
  );
  assert.equal(isRunTaskList([{ ...task(), status: "nope" }]), false);
});

test("the summary names the active task, then falls back to blocked counts", () => {
  assert.equal(
    summarizeTasks([task({ id: "a", status: "done" }), task({ id: "b", status: "active", title: "Wiring it up" })]),
    "1 of 2 done · Wiring it up",
  );
  assert.equal(
    summarizeTasks([task({ id: "a", status: "done" }), task({ id: "b", status: "blocked" })]),
    "1 of 2 done · 1 blocked",
  );
  assert.equal(summarizeTasks([task({ status: "done" })]), "1 of 1 done");
});

test("unfinished tasks are the pending and active ones, not the blocked ones", () => {
  const tasks = [
    task({ id: "a", status: "done" }),
    task({ id: "b", status: "pending" }),
    task({ id: "c", status: "active" }),
    task({ id: "d", status: "blocked" }),
  ];
  assert.deepEqual(unfinishedTasks(tasks).map((entry) => entry.id), ["b", "c"]);
});
