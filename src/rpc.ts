import { Rpc } from "@opencode/plugin/rpc";
import type { RuntimeStats } from "./runtime.ts";

export type RuntimeStatus = RuntimeStats & {
  projectID: string;
  directory: string;
  trackedSince: number;
};

const nullableNumber = {
  anyOf: [{ type: "number" }, { type: "null" }],
} as const;

const session = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    totalMs: { type: "number" },
    executions: { type: "number" },
    runningSince: nullableNumber,
    runningMs: { type: "number" },
  },
  required: ["sessionID", "totalMs", "executions", "runningSince", "runningMs"],
  additionalProperties: false,
} as const;

const project = {
  type: "object",
  properties: {
    totalMs: { type: "number" },
    executions: { type: "number" },
    sessions: { type: "number" },
    runningSessions: { type: "number" },
    runningMs: { type: "number" },
  },
  required: ["totalMs", "executions", "sessions", "runningSessions", "runningMs"],
  additionalProperties: false,
} as const;

const status = {
  type: "object",
  properties: {
    projectID: { type: "string" },
    directory: { type: "string" },
    trackedSince: { type: "number" },
    generatedAt: { type: "number" },
    session,
    project,
  },
  required: ["projectID", "directory", "trackedSince", "generatedAt", "session", "project"],
  additionalProperties: false,
} as const;

const statusInput = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const;

export const AgentRuntimeRpc = Rpc.define({
  id: "agent-runtime",
  methods: {
    status: { input: statusInput, output: status },
  },
  events: {},
} as const);
