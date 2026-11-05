/**
 * TUI part: live agent running time in the sidebar.
 *
 * The server part is the source of truth. The panel polls it occasionally and
 * advances the display locally between polls while an execution is running.
 */

import { Show, createMemo, createSignal, createEffect, on, onCleanup, onMount } from "solid-js";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { AgentRuntimeRpc, type RuntimeStatus } from "./rpc.ts";
import { formatDuration } from "./runtime.ts";

const POLL_MS = 10_000;

function Panel(props: { sessionID: string }) {
  const context = usePlugin();
  const [status, setStatus] = createSignal<RuntimeStatus>();
  const [now, setNow] = createSignal(Date.now());
  const hideWhenIdle = context.options.hideWhenIdle === true;

  let alive = true;
  let busy = false;
  let pending = false;

  const tick = async (): Promise<void> => {
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    const requested = props.sessionID;
    try {
      const rpc = context.client.rpc(AgentRuntimeRpc);
      const directory = context.data.session.get(requested)?.location.directory ?? context.location?.directory;
      const next = (await rpc.status(
        { sessionID: requested },
        directory ? { location: { directory } } : undefined,
      )) as unknown as RuntimeStatus;
      if (alive && requested === props.sessionID) {
        setStatus(next);
        setNow(Date.now());
      }
    } catch {
      // Server restarting or plugin unloaded: keep the last data.
    } finally {
      busy = false;
      if (pending) {
        pending = false;
        void tick();
      }
    }
  };

  onMount(() => {
    void tick();
    const poll = setInterval(() => void tick(), POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    onCleanup(() => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
    });
  });

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStatus(undefined);
        void tick();
      },
      { defer: true },
    ),
  );

  const sessionTotal = createMemo(() => {
    const current = status();
    if (!current) return 0;
    const delta = current.session.runningSince !== null ? Math.max(0, now() - current.generatedAt) : 0;
    return current.session.totalMs + current.session.runningMs + delta;
  });

  const sessionNow = createMemo(() => {
    const current = status();
    if (!current || current.session.runningSince === null) return 0;
    return current.session.runningMs + Math.max(0, now() - current.generatedAt);
  });

  const projectTotal = createMemo(() => {
    const current = status();
    if (!current) return 0;
    return (
      current.project.totalMs +
      current.project.runningMs +
      Math.max(0, now() - current.generatedAt) * current.project.runningSessions
    );
  });

  const visible = (): boolean => {
    const current = status();
    if (!current) return false;
    if (!hideWhenIdle) return true;
    return current.session.runningSince !== null || current.session.totalMs > 0;
  };

  return (
    <Show when={visible() ? status() : undefined}>
      {(current) => (
        <box flexDirection="column">
          <text fg={context.theme.text.faint}>AGENT RUNTIME</text>
          <text
            fg={
              current().session.runningSince !== null
                ? (context.theme.text.feedback.success.base ?? context.theme.text.base)
                : context.theme.text.base
            }
          >
            {`session  ${formatDuration(sessionTotal())}`}
          </text>
          <text fg={context.theme.text.muted}>
            {current().session.runningSince !== null
              ? `${current().session.executions + 1} run${current().session.executions === 0 ? "" : "s"} · running ${formatDuration(sessionNow())}`
              : `${current().session.executions} run${current().session.executions === 1 ? "" : "s"} · idle`}
          </text>

          <text fg={context.theme.text.base}>{`project  ${formatDuration(projectTotal())}`}</text>
          <text fg={context.theme.text.faint}>
            {`${current().project.executions} runs · ${current().project.sessions} session${
              current().project.sessions === 1 ? "" : "s"
            }`}
          </text>
          <Show when={current().project.runningSessions > 0}>
            <text fg={context.theme.text.feedback.success.base ?? context.theme.text.muted}>
              {`${current().project.runningSessions} running`}
            </text>
          </Show>
        </box>
      )}
    </Show>
  );
}

export default Plugin.define({
  id: "agent-runtime.tui",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: (input) => <Panel sessionID={input.sessionID} />,
    });
  },
});
