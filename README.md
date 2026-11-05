<h1 align="center">opencode-agent-runtime</h1>

<p align="center">
  Track total agent running time per session and per project in OpenCode V2.<br/>
  A small standalone plugin: server-side tracking + TUI sidebar + RPC + <code>agent_runtime</code> tool.
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
| **Session** | Total completed plus currently running agent execution time in the selected session. |
| **Project** | Total across every session in the project, including subagent sessions. |
| **Live** | If an execution is running, the sidebar keeps counting in real time. |
| **Persistent** | Values live in OpenCode's plugin storage and survive restarts. |

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
      "package": "/home/you/.local/share/opencode-agent-runtime/0.1.1",
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
session  1h 23m
4 runs · running 2m 10s
project  12h 45m
38 runs · 7 sessions
2 running
```

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
  is already in progress is adopted automatically.
- Finished executions are saved immediately. While an execution is running, a
  heartbeat writes the last known state every 15 seconds.
- If the server dies mid-run, the execution is counted up to the last heartbeat
  and marked as `interrupted` on the next start.
- Tracking starts when the plugin first loads. Earlier executions are not
  reconstructed retroactively.
- The project total sums all sessions in the project. A subagent session is
  counted separately, while its parent session also counts the time it spends
  waiting for it. The project total is therefore the sum of all agent runtime,
  not the project's wall-clock time.
- Storage is isolated per project (`state/<projectID>`).

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
- A hard crash can lose the last few seconds before the final heartbeat.
- If the same project runs in multiple OpenCode instances with this plugin at
  the same time, they share the same storage key. For normal single-machine use
  this is not a problem.
- Stats contain session IDs and titles; they stay in OpenCode's local plugin
  storage and are not sent anywhere.

## License

MIT
