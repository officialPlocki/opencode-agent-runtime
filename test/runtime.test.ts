import assert from "node:assert/strict";
import test from "node:test";
import {
  beginExecution,
  createProjectState,
  endExecution,
  formatDuration,
  liveStats,
  normalizeState,
  reconcileRunning,
  type ActiveSession,
} from "../src/runtime.ts";

const T0 = 1_700_000_000_000;

test("an execution adds its duration to the session and project", () => {
  const state = createProjectState("proj", "/work/proj", T0);

  beginExecution(state, "ses_a", T0, { title: "First" });
  assert.equal(endExecution(state, "ses_a", T0 + 90_000, "succeeded"), 90_000);

  beginExecution(state, "ses_a", T0 + 120_000);
  assert.equal(endExecution(state, "ses_a", T0 + 150_000, "failed"), 30_000);

  assert.equal(state.totalMs, 120_000);
  assert.equal(state.executions, 2);
  assert.equal(state.sessions.ses_a?.totalMs, 120_000);
  assert.equal(state.sessions.ses_a?.executions, 2);
  assert.equal(state.sessions.ses_a?.lastOutcome, "failed");
  assert.deepEqual(state.running, {});
});

test("a duplicate start keeps the earliest timestamp", () => {
  const state = createProjectState("proj", "/work/proj", T0);

  beginExecution(state, "ses_a", T0 + 10_000);
  beginExecution(state, "ses_a", T0 + 5_000);

  assert.equal(state.running.ses_a?.startedAt, T0 + 5_000);
  assert.equal(endExecution(state, "ses_a", T0 + 15_000, "succeeded"), 10_000);
});

test("ending without a start is ignored", () => {
  const state = createProjectState("proj", "/work/proj", T0);

  assert.equal(endExecution(state, "ses_missing", T0 + 1_000, "succeeded"), undefined);
  assert.equal(state.totalMs, 0);
  assert.equal(state.executions, 0);
});

test("live stats include currently running executions", () => {
  const state = createProjectState("proj", "/work/proj", T0);
  beginExecution(state, "ses_a", T0);
  beginExecution(state, "ses_b", T0 + 5_000);

  const stats = liveStats(state, "ses_a", T0 + 20_000);

  assert.equal(stats.session.totalMs, 0);
  assert.equal(stats.session.runningSince, T0);
  assert.equal(stats.session.runningMs, 20_000);
  assert.equal(stats.project.runningSessions, 2);
  assert.equal(stats.project.runningMs, 20_000 + 15_000);
  assert.equal(stats.project.executions, 0);
});

test("reconcile closes runs that ended while the plugin was offline", () => {
  const state = createProjectState("proj", "/work/proj", T0);
  beginExecution(state, "ses_a", T0);
  state.heartbeatAt = T0 + 60_000;

  const active = new Map<string, ActiveSession>([
    ["ses_a", { busy: T0, idle: T0 + 45_000, outcome: "succeeded" }],
  ]);

  assert.equal(reconcileRunning(state, active, T0 + 600_000), true);
  assert.equal(state.totalMs, 45_000);
  assert.equal(state.executions, 1);
  assert.equal(state.running.ses_a, undefined);
});

test("reconcile adopts an execution that was already running", () => {
  const state = createProjectState("proj", "/work/proj", T0);
  const active = new Map<string, ActiveSession>([
    ["ses_a", { busy: T0 + 10_000, idle: T0 + 5_000, title: "Existing" }],
  ]);

  assert.equal(reconcileRunning(state, active, T0 + 30_000), true);
  assert.equal(state.running.ses_a?.startedAt, T0 + 10_000);
  assert.equal(state.sessions.ses_a?.title, "Existing");
});

test("reconcile closes an old run and adopts a newer one", () => {
  const state = createProjectState("proj", "/work/proj", T0);
  beginExecution(state, "ses_a", T0);
  state.heartbeatAt = T0 + 60_000;

  const active = new Map<string, ActiveSession>([
    ["ses_a", { busy: T0 + 40_000, idle: T0 + 30_000, outcome: "succeeded" }],
  ]);

  assert.equal(reconcileRunning(state, active, T0 + 50_000), true);
  assert.equal(state.totalMs, 30_000);
  assert.equal(state.executions, 1);
  assert.equal(state.running.ses_a?.startedAt, T0 + 40_000);
});

test("reconcile drops persisted runs whose session is gone", () => {
  const state = createProjectState("proj", "/work/proj", T0);
  beginExecution(state, "ses_a", T0);
  state.heartbeatAt = T0 + 30_000;

  assert.equal(reconcileRunning(state, new Map(), T0 + 3_600_000), true);
  assert.equal(state.totalMs, 30_000);
  assert.equal(state.running.ses_a, undefined);
});

test("normalizeState ignores malformed data and keeps valid records", () => {
  const normalized = normalizeState(
    {
      version: 1,
      totalMs: 5_000,
      executions: 1,
      sessions: {
        ses_a: { totalMs: 5_000, executions: 1, firstAt: T0, updatedAt: T0 + 5_000 },
        bad: "nope",
      },
      running: {
        ses_b: { startedAt: T0 + 10_000 },
        bad: { startedAt: "later" },
      },
    },
    "proj",
    "/work/proj",
    T0 + 20_000,
  );

  assert.equal(normalized.totalMs, 5_000);
  assert.equal(normalized.executions, 1);
  assert.equal(normalized.sessions.ses_a?.totalMs, 5_000);
  assert.equal(normalized.sessions.bad, undefined);
  assert.equal(normalized.running.ses_b?.startedAt, T0 + 10_000);
  assert.equal(normalized.running.bad, undefined);
});

test("normalizeState discards an unknown version", () => {
  const normalized = normalizeState({ version: 2, totalMs: 99_000 }, "proj", "/work/proj", T0);
  assert.equal(normalized.version, 1);
  assert.equal(normalized.totalMs, 0);
});

test("formatDuration uses compact human units", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(400), "<1s");
  assert.equal(formatDuration(9_000), "9s");
  assert.equal(formatDuration(65_000), "1m 05s");
  assert.equal(formatDuration(3_600_000), "1h 00m");
  assert.equal(formatDuration(90_000_000), "1d 1h");
});
