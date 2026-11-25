# Specs

Each file here describes one feature as it is now: what it does, where its boundaries are, and what it deliberately does not do. A spec is rewritten in place when the feature changes and deleted, together with its row below, when the feature is removed; the history of changes is in git, not in the spec.

A spec states product behaviour, facts about the external systems the feature relies on, persisted formats and architectural constraints. It does not describe how the current code is organised, and it does not cite tickets, branches or working records, which are cleaned up while the spec stays. Decisions and the alternatives they rejected are in `docs/adr/`; a spec refers to an ADR by number.

| Spec | In one line |
|---|---|
| [claude-session-pool](claude-session-pool.md) | The ten tools with which a dispatcher session opens, adopts, clears, compacts, inspects, closes, replaces, releases and restores worker sessions running in Terminal windows. |
| [claude-session-pool-compact-self](claude-session-pool-compact-self.md) | The tool `compact_self`, with which a session compacts its own conversation and is woken afterwards so that it carries on. |
| [claude-session-pool-context-usage](claude-session-pool-context-usage.md) | The tool `context_usage`, with which a session in which the plugin's mod runs learns the size of its own context. |
| [claude-session-pool-monitor](claude-session-pool-monitor.md) | The pool monitor: in a dispatcher session the plugin's mod looks at every slot once a minute, records what each look finds, which `status` states for a slot whose session has ended, and starts a turn with a report when a slot stops, stalls, waits on a prompt or disappears. |
| [claude-session-pool-plugin](claude-session-pool-plugin.md) | The one Claude Code plugin that carries the server, the hooks and the mod, the one installation that gives it to every session, the hook record that shows the hooks run, and how the mod looks once a minute, records its session's activity and reports. |
| [claude-session-pool-startup](claude-session-pool-startup.md) | The start-up command that starts the dispatcher session under one name across restarts, marks it, and gives it the plugin where the installation does not reach it. |
| [claude-session-pool-subagent-watch](claude-session-pool-subagent-watch.md) | The subagent watch: in every interactive session the plugin's mod looks at the session's subagents once a minute and starts a turn with a report when one is stuck. |
