/**
 * Pure state and formatting helpers for the agent runtime tracker.
 *
 * Everything in this module is deliberately free of OpenCode imports so it can
 * be unit tested without loading the plugin runtime.
 */

export type RuntimeOutcome = "succeeded" | "failed" | "interrupted";

export type SessionRecord = {
  id: string;
  title?: string;
  parentID?: string;
  executions: number;
  totalMs: number;
  lastStartedAt?: number;
  lastEndedAt?: number;
  lastOutcome?: RuntimeOutcome;
  firstAt: number;
  updatedAt: number;
};

export type RunningRecord = {
  startedAt: number;
};

export type ProjectState = {
  version: 1;
  projectID: string;
  directory: string;
  /** Completed execution time. Currently running executions are kept separately. */
  totalMs: number;
  /** Completed executions. */
  executions: number;
  sessions: Record<string, SessionRecord>;
  running: Record<string, RunningRecord>;
  trackedSince: number;
  updatedAt: number;
  heartbeatAt: number;
};

export type ActiveSession = {
  busy?: number;
  idle?: number;
  outcome?: RuntimeOutcome;
  title?: string;
  parentID?: string;
};

export type SessionStats = {
  sessionID: string;
  /** Completed execution time for this session and all of its subagent descendants. */
  totalMs: number;
  /** Completed executions for this session and all of its subagent descendants. */
  executions: number;
  /** Completed execution time of this session only. */
  ownTotalMs: number;
  /** Completed executions of this session only. */
  ownExecutions: number;
  /** Number of descendant subagent sessions. */
  subagents: number;
  /** Completed execution time of all descendant subagent sessions. */
  subagentTotalMs: number;
  /** Completed executions of all descendant subagent sessions. */
  subagentExecutions: number;
  /** Start of this session's own running execution, if any. */
  ownRunningSince: number | null;
  /** Elapsed time of this session's own running execution. */
  ownRunningMs: number;
  /** Earliest start among running executions in this session's family. */
  activeSince: number | null;
  /** Number of running executions in this session's family. */
  runningSessions: number;
  /** Sum of all running execution durations in this session's family. */
  runningMs: number;
};

export type ProjectStats = {
  totalMs: number;
  executions: number;
  sessions: number;
  runningSessions: number;
  runningMs: number;
};

export type RuntimeStats = {
  generatedAt: number;
  session: SessionStats;
  project: ProjectStats;
};

export type SessionMeta = {
  title?: string;
  parentID?: string;
};

const MAX_SESSIONS = 2_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown, fallback = 0): number {
  return Math.max(0, finite(value, fallback));
}

function integer(value: unknown, fallback = 0): number {
  return Math.max(0, Math.floor(nonNegative(value, fallback)));
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function outcome(value: unknown): RuntimeOutcome | undefined {
  return value === "succeeded" || value === "failed" || value === "interrupted" ? value : undefined;
}

export function createProjectState(projectID: string, directory: string, now = Date.now()): ProjectState {
  return {
    version: 1,
    projectID,
    directory,
    totalMs: 0,
    executions: 0,
    sessions: {},
    running: {},
    trackedSince: now,
    updatedAt: now,
    heartbeatAt: now,
  };
}

export function normalizeState(
  raw: unknown,
  projectID: string,
  directory: string,
  now = Date.now(),
): ProjectState {
  const state = createProjectState(projectID, directory, now);
  if (!isObject(raw) || raw.version !== 1) return state;

  state.directory = optionalString(raw.directory) ?? directory;
  state.trackedSince = finite(raw.trackedSince, now);
  state.updatedAt = finite(raw.updatedAt, now);
  state.heartbeatAt = finite(raw.heartbeatAt, now);
  state.totalMs = nonNegative(raw.totalMs);
  state.executions = integer(raw.executions);

  if (isObject(raw.sessions)) {
    for (const [id, value] of Object.entries(raw.sessions)) {
      if (!isObject(value)) continue;
      const record: SessionRecord = {
        id,
        executions: integer(value.executions),
        totalMs: nonNegative(value.totalMs),
        firstAt: finite(value.firstAt, now),
        updatedAt: finite(value.updatedAt, now),
      };
      const title = optionalString(value.title);
      const parentID = optionalString(value.parentID);
      const lastStartedAt = optionalNumber(value.lastStartedAt);
      const lastEndedAt = optionalNumber(value.lastEndedAt);
      const lastOutcome = outcome(value.lastOutcome);
      if (title) record.title = title;
      if (parentID) record.parentID = parentID;
      if (lastStartedAt !== undefined) record.lastStartedAt = lastStartedAt;
      if (lastEndedAt !== undefined) record.lastEndedAt = lastEndedAt;
      if (lastOutcome) record.lastOutcome = lastOutcome;
      state.sessions[id] = record;
    }
  }

  if (isObject(raw.running)) {
    for (const [id, value] of Object.entries(raw.running)) {
      if (!isObject(value)) continue;
      const startedAt = optionalNumber(value.startedAt);
      if (startedAt === undefined || startedAt < 0) continue;
      state.running[id] = { startedAt };
    }
  }

  return state;
}

export function ensureSession(
  state: ProjectState,
  sessionID: string,
  now: number,
  meta?: SessionMeta,
): SessionRecord {
  const existing = state.sessions[sessionID];
  if (existing) {
    if (meta?.title && !existing.title) existing.title = meta.title;
    if (meta?.parentID && !existing.parentID) existing.parentID = meta.parentID;
    return existing;
  }

  const record: SessionRecord = {
    id: sessionID,
    executions: 0,
    totalMs: 0,
    firstAt: now,
    updatedAt: now,
  };
  if (meta?.title) record.title = meta.title;
  if (meta?.parentID) record.parentID = meta.parentID;
  state.sessions[sessionID] = record;
  return record;
}

/** Record the start of an execution. Duplicate starts keep the earliest timestamp. */
export function beginExecution(
  state: ProjectState,
  sessionID: string,
  startedAt: number,
  meta?: SessionMeta,
): RunningRecord {
  const record = ensureSession(state, sessionID, startedAt, meta);
  let running = state.running[sessionID];
  if (!running) {
    running = { startedAt };
    state.running[sessionID] = running;
  } else if (startedAt < running.startedAt) {
    running.startedAt = startedAt;
  }

  record.lastStartedAt = running.startedAt;
  record.updatedAt = startedAt;
  state.updatedAt = Math.max(state.updatedAt, startedAt);
  state.heartbeatAt = Math.max(state.heartbeatAt, startedAt);
  return running;
}

/**
 * Record the end of an execution. Returns the measured duration, or undefined
 * when there was no matching start (for example an event stream gap).
 */
export function endExecution(
  state: ProjectState,
  sessionID: string,
  endedAt: number,
  result: RuntimeOutcome,
  at = endedAt,
): number | undefined {
  const running = state.running[sessionID];
  if (!running) return undefined;

  const duration = Math.max(0, endedAt - running.startedAt);
  const record = ensureSession(state, sessionID, at);
  record.totalMs += duration;
  record.executions += 1;
  record.lastEndedAt = endedAt;
  record.lastOutcome = result;
  record.updatedAt = at;

  state.totalMs += duration;
  state.executions += 1;
  delete state.running[sessionID];
  state.updatedAt = Math.max(state.updatedAt, at);
  state.heartbeatAt = Math.max(state.heartbeatAt, at);
  return duration;
}

/**
 * Reconcile persisted running entries with the server's active session list.
 * This closes executions that ended while the server was down and adopts
 * executions that were already running when the plugin loaded.
 */
export function reconcileRunning(
  state: ProjectState,
  active: ReadonlyMap<string, ActiveSession>,
  now = Date.now(),
): boolean {
  let changed = false;
  const heartbeat = state.heartbeatAt || now;

  for (const [sessionID, running] of Object.entries(state.running)) {
    const info = active.get(sessionID);
    if (!info) {
      if (endExecution(state, sessionID, Math.min(heartbeat, now), "interrupted", now) !== undefined) changed = true;
      continue;
    }

    if (info.title) ensureSession(state, sessionID, now, { title: info.title, parentID: info.parentID });

    if (isRunning(info)) {
      if (info.busy === undefined) continue;

      if (info.busy > running.startedAt) {
        // A new execution started while the plugin was offline. Close the old
        // one at the previous idle time when available, then adopt the new one.
        const endedAt = info.idle !== undefined && info.idle >= running.startedAt ? info.idle : info.busy;
        endExecution(state, sessionID, endedAt, info.outcome ?? "interrupted", now);
        beginExecution(state, sessionID, info.busy, { title: info.title, parentID: info.parentID });
        changed = true;
      } else if (info.busy < running.startedAt) {
        running.startedAt = info.busy;
        changed = true;
      }
      continue;
    }

    const endedAt = Math.min(info.idle ?? heartbeat, now);
    if (endExecution(state, sessionID, endedAt, info.outcome ?? "interrupted", now) !== undefined) changed = true;
  }

  for (const [sessionID, info] of active) {
    if (state.running[sessionID]) continue;
    if (!isRunning(info) || info.busy === undefined) continue;
    beginExecution(state, sessionID, info.busy, { title: info.title, parentID: info.parentID });
    changed = true;
  }

  return changed;
}

function isRunning(info: ActiveSession): boolean {
  return info.busy !== undefined && (info.idle === undefined || info.busy > info.idle);
}

function sessionFamily(state: ProjectState, rootID: string): SessionRecord[] {
  const children = new Map<string, SessionRecord[]>();
  for (const record of Object.values(state.sessions)) {
    if (!record.parentID) continue;
    const list = children.get(record.parentID);
    if (list) list.push(record);
    else children.set(record.parentID, [record]);
  }

  const family: SessionRecord[] = [];
  const seen = new Set<string>();
  const queue = [rootID];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);

    const record = state.sessions[id];
    if (record) family.push(record);
    for (const child of children.get(id) ?? []) queue.push(child.id);
  }
  return family;
}

export function liveStats(state: ProjectState, sessionID: string, now = Date.now()): RuntimeStats {
  const family = sessionFamily(state, sessionID);
  const ownRunning = state.running[sessionID];
  const starts = Object.values(state.running);
  const projectRunningMs = starts.reduce((sum, entry) => sum + Math.max(0, now - entry.startedAt), 0);

  let totalMs = 0;
  let executions = 0;
  let subagents = 0;
  let subagentTotalMs = 0;
  let subagentExecutions = 0;
  let activeSince: number | null = null;
  let runningSessions = 0;
  let runningMs = 0;

  for (const record of family) {
    totalMs += record.totalMs;
    executions += record.executions;

    const running = state.running[record.id];
    if (record.id !== sessionID) {
      if (record.executions > 0 || running) subagents += 1;
      subagentTotalMs += record.totalMs;
      subagentExecutions += record.executions;
    }

    if (running) {
      runningSessions += 1;
      runningMs += Math.max(0, now - running.startedAt);
      activeSince = activeSince === null ? running.startedAt : Math.min(activeSince, running.startedAt);
    }
  }

  return {
    generatedAt: now,
    session: {
      sessionID,
      totalMs,
      executions,
      ownTotalMs: state.sessions[sessionID]?.totalMs ?? 0,
      ownExecutions: state.sessions[sessionID]?.executions ?? 0,
      subagents,
      subagentTotalMs,
      subagentExecutions,
      ownRunningSince: ownRunning?.startedAt ?? null,
      ownRunningMs: ownRunning ? Math.max(0, now - ownRunning.startedAt) : 0,
      activeSince,
      runningSessions,
      runningMs,
    },
    project: {
      totalMs: state.totalMs,
      executions: state.executions,
      sessions: Object.values(state.sessions).filter(
        (entry) => entry.executions > 0 || state.running[entry.id] !== undefined,
      ).length,
      runningSessions: starts.length,
      runningMs: projectRunningMs,
    },
  };
}

/** Keep storage bounded without touching the project's all-time total. */
export function pruneSessions(state: ProjectState, max = MAX_SESSIONS): boolean {
  const entries = Object.entries(state.sessions);
  if (entries.length <= max) return false;

  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  let removed = false;
  for (const [id] of entries.slice(max)) {
    if (state.running[id]) continue;
    delete state.sessions[id];
    removed = true;
  }
  return removed;
}

export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safe / 1_000);
  if (totalSeconds < 1) return safe > 0 ? "<1s" : "0s";

  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600) % 24;
  const days = Math.floor(totalSeconds / 86_400);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatTimer(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safe / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatReport(stats: RuntimeStats, projectLabel?: string): string {
  const { session, project } = stats;
  const sessionTotal = session.totalMs + session.runningMs;
  const projectTotal = project.totalMs + project.runningMs;
  const sessionRuns = session.executions + session.runningSessions;
  const activeMs = session.activeSince !== null ? Math.max(0, stats.generatedAt - session.activeSince) : 0;

  const lines = [
    "# Agent runtime",
    "",
    `- Session: ${formatDuration(sessionTotal)} · ${sessionRuns} run${sessionRuns === 1 ? "" : "s"}${
      session.subagents > 0 ? ` · ${session.subagents} subagent${session.subagents === 1 ? "" : "s"}` : ""
    }${session.activeSince !== null ? ` · active for ${formatDuration(activeMs)}` : ""}`,
    `- Project${projectLabel ? ` (${projectLabel})` : ""}: ${formatDuration(projectTotal)} · ${
      project.executions
    } runs · ${project.sessions} session${project.sessions === 1 ? "" : "s"}${
      project.runningSessions > 0 ? ` · ${project.runningSessions} running` : ""
    }`,
  ];

  if (session.subagents > 0) {
    lines.push(
      `- Subagents: ${formatDuration(session.subagentTotalMs)} · ${session.subagentExecutions} run${
        session.subagentExecutions === 1 ? "" : "s"
      }`,
    );
  }

  return lines.join("\n");
}
