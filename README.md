<h1 align="center">opencode-agent-runtime</h1>

<p align="center">
  Track total agent running time per session and per project in OpenCode V2.<br/>
  Live current-run timer + persisted session/project totals, including subagents.
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-V2-111111" />
  <img alt="Status" src="https://img.shields.io/badge/status-experimental-orange" />
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/officialPlocki/opencode-agent-runtime?style=flat" />
</p>

## What it tracks

| Scope | Meaning |
| --- | --- |
| **Session** | Completed plus currently running agent execution time for the selected session **and all of its subagent descendants**. |
| **Project** | Total across every session in the project, including subagents. |
| **Current timer** | Live clock for the active execution in the selected session family. |
| **Persistent** | Completed totals and the running-timer start are stored in OpenCode's plugin storage and survive reloads/restarts. |

Time is measured as wall-clock time between `session.execution.started` and
`session.execution.succeeded` / `failed` / `interrupted`. This includes waiting
for tools, permission prompts, and subagents. In other words: the time the
agent is actually busy, not just raw model time.

## Install

```bash
git clone https://github.com/officialPlocki/opencode-agent-runtime.git \
  ~/.local/share/opencode-agent-runtime-src
cd ~/.local/share/opencode-agent-runtime-src
npm install --omit=dev
```

Add it to `~/.config/opencode/opencode.json` (global, for every project) or to
`opencode.json` / `.opencode/opencode.json` in a project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/home/you/.local/share/opencode-agent-runtime-src"
  ]
}
```

Then run `/reload` in OpenCode. No restart is required.

### Versioned local install

The repository also ships an `install:local` helper that copies the current
version into `~/.local/share/opencode-agent-runtime/<version>` and installs its
production dependencies:

```bash
npm run install:local
```

Point the plugin entry at the printed directory.

### Options

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/.local/share/opencode-agent-runtime/0.2.1",
      "options": {
        "hideWhenIdle": false
      }
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `hideWhenIdle` | `false` | Hide the sidebar panel while the session has never run and is not currently running. |

## Usage

### Sidebar

```text
AGENT RUNTIME
now      2m 11s
session  1h 23m
4 runs · 2 subagents
project  12h 45m
38 runs · 7 sessions
2 running
```

`now` is the live timer for the active execution in the current session family.
It keeps ticking while the selected session or one of its subagents is running.
`session` includes completed time plus the live portion of every running
execution in that family.

### Slash command

```text
/agent-runtime
```

Posts a short summary as a synthetic message into the current session.

### Tool

The `agent_runtime` tool returns the same summary so an agent can query it
directly.

## How it works

- The server part subscribes to OpenCode's execution events.
- On startup it reconciles running sessions with the server. An execution that
  is already in progress is adopted automatically, so the live timer resumes
  from its persisted start time instead of resetting to zero.
- Finished executions are saved immediately. While an execution is running, a
  heartbeat writes the last known state every 15 seconds.
- If the server dies mid-run, the execution is counted up to the last heartbeat
  and marked as `interrupted` on the next start.
- Tracking starts when the plugin first loads. Earlier executions are not
  reconstructed retroactively.
- A session total includes its own executions plus every descendant subagent
  session. The project total independently sums every session in the project,
  so subagent time is counted once in the project and once in its ancestor
  session total.
- Parent and subagent sessions can run at the same time. The totals are therefore
  additive agent runtime, not the project's wall-clock time.
- Storage is isolated per project (`state/<projectID>`).

### Timer persistence

The running timer is not just a TUI-local counter. The server stores the
execution's `startedAt` in the plugin state as soon as it starts, and the
15-second heartbeat saves the last known state while it runs. After a plugin
reload or server restart, the plugin reconciles against the active session list
and restores the timer from its original start time. If the session is no longer
running, the execution is closed at the last known end (or heartbeat) instead of
leaving a stuck timer.

## Development

```bash
npm install
npm run typecheck
npm test
```

The state and formatting logic lives in `src/runtime.ts` and has no OpenCode
dependencies, so it can be tested in isolation.

## Limitations

- Only executions that happen after install / plugin load are counted.
- A hard crash can lose at most the last heartbeat interval of a running timer.
- Because session totals add subagent time on top of the parent's own busy time,
  concurrent parent/subagent work is counted as agent runtime, not wall-clock.
- If the same project runs in multiple OpenCode instances with this plugin at
  the same time, they share the same storage key. For normal single-machine use
  this is not a problem.
- Stats contain session IDs and titles; they stay in OpenCode's local plugin
  storage and are not sent anywhere.

## License

MIT
