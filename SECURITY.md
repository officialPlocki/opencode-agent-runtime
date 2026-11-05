# Security policy

## Supported versions

The current `0.1.x` line receives fixes.

## Reporting a vulnerability

Report security issues privately through a GitHub security advisory on the
repository. Do not open a public issue for credential leaks or data exposure.

## Data handling

- The plugin stores runtime statistics in OpenCode's local plugin storage.
- Stored records contain session IDs, optional session titles, parent session
  IDs, timestamps, and durations.
- The plugin makes no network requests and has no analytics or telemetry.
- Statistics are exposed locally through the plugin RPC and the
  `agent_runtime` tool.
