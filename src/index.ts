import { Plugin } from "@opencode/plugin";
import { AgentRuntimeRpc } from "./rpc.ts";
import {
  beginExecution,
  ensureSession,
  endExecution,
  formatReport,
  liveStats,
  normalizeState,
  pruneSessions,
  reconcileRunning,
  type ActiveSession,
  type ProjectState,
  type RuntimeOutcome,
} from "./runtime.ts";

const HEARTBEAT_MS = 15_000;
const RECONNECT_MS = 2_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

const EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.renamed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

function projectLabel(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? directory;
}

export default Plugin.define({
  id: "agent-runtime",
  async setup(ctx) {
    const projectID = ctx.location.project.id;
    const directory = ctx.location.directory;
    const storageKey = `state/${encodeURIComponent(projectID)}`;
    const log = (message: string) => console.error(`[agent-runtime] ${message}`);

    let state: ProjectState = normalizeState(
      await ctx.storage.get(storageKey).catch(() => undefined),
      projectID,
      directory,
    );

    // Serialize writes and snapshot before they leave the event loop so state
    // mutations cannot race an in-flight storage write.
    let write: Promise<void> = Promise.resolve();
    const save = (): Promise<void> => {
      state.updatedAt = Date.now();
      const snapshot = JSON.parse(JSON.stringify(state)) as never;
      write = write
        .then(() => ctx.storage.set(storageKey, snapshot))
        .catch((cause) => log(`could not save stats: ${cause instanceof Error ? cause.message : String(cause)}`));
      return write;
    };

    const projectBySession = new Map<string, string>();
    const knownDirectories = new Set<string>([directory]);

    const hydrate = async (): Promise<Map<string, ActiveSession>> => {
      const active = new Map<string, ActiveSession>();
      let cursor: string | undefined;

      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await ctx.session.list({ project: projectID, limit: PAGE_SIZE, cursor });
        for (const info of result.data) {
          projectBySession.set(info.id, info.projectID);
          if (info.location?.directory) knownDirectories.add(info.location.directory);
          active.set(info.id, {
            busy: info.time.busy,
            idle: info.time.idle,
            outcome: info.outcome as RuntimeOutcome | undefined,
            title: info.title,
            parentID: info.parentID,
          });
        }
        const next = result.cursor.next;
        if (!next) break;
        cursor = next;
      }

      return active;
    };

    try {
      const active = await hydrate();
      if (reconcileRunning(state, active)) await save();
    } catch (cause) {
      log(`could not read active sessions: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    const ownerOf = async (sessionID: string, eventDirectory?: string): Promise<string | undefined> => {
      const cached = projectBySession.get(sessionID);
      if (cached) return cached;

      try {
        const info = await ctx.session.get({ sessionID });
        projectBySession.set(info.id, info.projectID);
        if (info.location?.directory) knownDirectories.add(info.location.directory);
        return info.projectID;
      } catch {
        // The session may already be gone. Fall back to the event location when
        // it belongs to this project, otherwise leave ownership unknown.
        if (eventDirectory && knownDirectories.has(eventDirectory)) return projectID;
        return undefined;
      }
    };

    const isOurs = async (sessionID: string, eventDirectory?: string): Promise<boolean> => {
      const owner = await ownerOf(sessionID, eventDirectory);
      if (owner === undefined) return state.running[sessionID] !== undefined;
      return owner === projectID;
    };

    const handle = async (event: any): Promise<void> => {
      switch (event.type as string) {
        case "session.created": {
          const data = event.data as {
            sessionID: string;
            projectID: string;
            location?: { directory?: string };
            title?: string;
            parentID?: string;
          };
          if (data.projectID !== projectID) return;
          projectBySession.set(data.sessionID, data.projectID);
          if (data.location?.directory) knownDirectories.add(data.location.directory);
          ensureSession(state, data.sessionID, event.created as number, {
            title: data.title,
            parentID: data.parentID,
          });
          await save();
          return;
        }

        case "session.deleted": {
          const data = event.data as { sessionID: string };
          if (!(await isOurs(data.sessionID, event.location?.directory))) return;
          if (state.running[data.sessionID]) {
            endExecution(state, data.sessionID, event.created as number, "interrupted", event.created as number);
            await save();
          }
          return;
        }

        case "session.renamed": {
          const data = event.data as { sessionID: string; title: string };
          if (!(await isOurs(data.sessionID, event.location?.directory))) return;
          const record = state.sessions[data.sessionID];
          if (!record) return;
          record.title = data.title;
          record.updatedAt = event.created as number;
          await save();
          return;
        }

        case "session.execution.started": {
          const data = event.data as { sessionID: string };
          if (!(await isOurs(data.sessionID, event.location?.directory))) return;
          beginExecution(state, data.sessionID, event.created as number);
          await save();
          return;
        }

        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted": {
          const data = event.data as { sessionID: string };
          if (!(await isOurs(data.sessionID, event.location?.directory))) return;
          const result: RuntimeOutcome =
            event.type === "session.execution.succeeded"
              ? "succeeded"
              : event.type === "session.execution.failed"
                ? "failed"
                : "interrupted";
          if (endExecution(state, data.sessionID, event.created as number, result) !== undefined) {
            if (pruneSessions(state)) state.updatedAt = Date.now();
            await save();
          }
          return;
        }
      }
    };

    const controller = new AbortController();

    const consumeEvents = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ types: [...EVENT_TYPES], signal: controller.signal })) {
            try {
              await handle(event);
            } catch (cause) {
              log(`event handling failed: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
          }
        } catch (cause) {
          if (controller.signal.aborted) return;
          log(`event stream failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }

        if (!controller.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
        }
      }
    };

    void consumeEvents();

    const heartbeat = setInterval(() => {
      if (Object.keys(state.running).length === 0) return;
      state.heartbeatAt = Date.now();
      void save();
    }, HEARTBEAT_MS);

    await ctx.rpc.register(AgentRuntimeRpc, {
      status: async (input) => {
        const { sessionID } = input as { sessionID: string };
        const stats = liveStats(state, sessionID);
        return {
          ...stats,
          projectID,
          directory: state.directory,
          trackedSince: state.trackedSince,
        };
      },
    });

    const report = (sessionID: string, now = Date.now()): string =>
      formatReport(liveStats(state, sessionID, now), projectLabel(ctx.location.project.directory));

    await ctx.command.transform((editor) => {
      editor.add({
        name: "agent-runtime",
        description: "Show total agent running time for this session and project",
        execute: async ({ sessionID }) => {
          try {
            await ctx.session.synthetic({ sessionID, text: report(sessionID) });
          } catch (cause) {
            log(`could not post report: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        },
      });
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "agent_runtime",
        description:
          "Report the total time the agent has been running in the current session and across the whole project.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (_input: unknown, context) => {
          return { content: report(context.sessionID) };
        },
      });
    });

    log(`tracking project ${projectLabel(ctx.location.project.directory)}`);

    return async () => {
      controller.abort();
      clearInterval(heartbeat);
      await save();
    };
  },
});
