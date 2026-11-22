# claude-session-pool-plugin

> Related: [ADR-0004](../adr/0004-one-plugin-installed-once.md)

## Problem Statement

The server that offers the pool's tools, the hooks that wake a session and the mod that answers inside a session work only together: a session that has a tool without the hooks is never woken. Claude Code reads each of the three from a different place. Every session of the owner's needs all three, each tool under one name in every session, and the owner needs one installation to get them.

## Solution

One Claude Code plugin carries the server, two command hooks and the mod. The owner installs it once at user scope, from a marketplace in this repository, and every session of the owner's then loads it. The start-up command gives the dispatcher session the plugin where that installation does not reach it ([claude-session-pool-startup](claude-session-pool-startup.md)).

## Functional Requirements

### claude-session-pool-plugin::REQ-001 The plugin's hooks record that they run in a session

- claude-session-pool-plugin::REQ-001/AC-01: On `SessionStart`, for every way a session starts, a hook of the plugin writes the hook record of its session and deletes every hook record whose process no longer runs. It writes nothing to its standard output stream, which Claude Code would add to the conversation.
- claude-session-pool-plugin::REQ-001/AC-02: The server takes the plugin's hooks to run in a session only when the hook record named after the session's process exists and its `sessionId` is the session's present session ID. Because the `SessionStart` hook runs again after `/clear`, the record follows the conversation.
- claude-session-pool-plugin::REQ-001/AC-03: Given an event other than `SessionStart` and `PostCompact`, or input without a session ID, a hook of the plugin writes one line that begins with the plugin's name to its standard error stream and exits with code 1. That wakes no session and changes no file.

### claude-session-pool-plugin::REQ-002 The mod asks Claude Code again (direct acceptance)

Where a feature of the plugin says that the mod asks Claude Code again after a refusal, it asks 2 seconds later, up to 5 times.

### claude-session-pool-plugin::REQ-003 The mod answers two tools only (direct acceptance)

The mod answers calls to two tools: `mcp__plugin_cc-session-pool_pool__compact_self` ([claude-session-pool-compact-self::US-001/AC-02](claude-session-pool-compact-self.md)) and its own `context_usage` ([claude-session-pool-context-usage::US-001/AC-01](claude-session-pool-context-usage.md)). Every other tool call passes through it unchanged.

## Constraints

### claude-session-pool-plugin::CON-001 One plugin carries the server, the hooks and the mod

Applies to: how a session gets the pool's tools, the hooks and the mod (ADR-0004).

- claude-session-pool-plugin::CON-001/AC-01: The server, the hooks and the mod are one Claude Code plugin, named `cc-session-pool`, in which the server is named `pool`. A session sees each of the server's tools as `mcp__plugin_cc-session-pool_pool__<tool>`, and the tool definitions are loaded up front, so the session calls a tool without first searching for it.
- claude-session-pool-plugin::CON-001/AC-02: A session the start-up command did not start has the server, the hooks and the mod only when the plugin is installed at user scope. With that installation every Claude Code session of this user on this Mac loads the plugin, in any directory, unless a setting disables it there. The owner installs it once; neither the server nor the start-up command installs, changes or removes it.

### claude-session-pool-plugin::CON-002 Runtime (direct acceptance)

Applies to: the server process, the hook processes and the start-up command; each runs on the `node` found on the `PATH` of the session it serves, which must be Node.js 22.18 or later, with no build step.

## Failure modes and boundaries

- **The `node` on a session's `PATH` is older than claude-session-pool-plugin::CON-002 requires**: the server does not start in that session, and Claude Code lists it as failed there; the hooks fail there too and write no hook record. Other sessions are not affected.
- **The plugin's hooks do not run in a session**, for example because its settings switch all hooks off: no hook record exists for the session. Hooks that are switched off after the hook record was written are not detected.
- **`/clear` is followed at once by a call that consults the hook record**: the record may still name the old session ID, and the plugin's hooks are then taken not to run in the session (claude-session-pool-plugin::REQ-001/AC-02).

## Implementation Decisions

### Hooks and the mod

The plugin declares two command hooks, each run with `node` and with its program and arguments given separately: one on `SessionStart` (claude-session-pool-plugin::REQ-001), and one on `PostCompact` that [claude-session-pool-compact-self](claude-session-pool-compact-self.md) describes. The plugin's hooks file names one hooks module, the mod, beside them.

### State files

The files of the plugin lie under `~/.claude-session-pool/`: `pools/` holds rosters ([claude-session-pool](claude-session-pool.md)), `hooks/` hook records, `wake-requests/` wake requests ([claude-session-pool-compact-self](claude-session-pool-compact-self.md)) and `clear-orders/` clear orders ([claude-session-pool](claude-session-pool.md)).

- A hook record is the file `~/.claude-session-pool/hooks/<pid>.json`, where `<pid>` is the process ID of the session, which is the hook's parent process. Content: a JSON object with `version` (the number `1`), `pid` and `sessionId`, the session ID the hook received.
- A file of the three kinds that a hook, the server and the mod write for one another (hook record, wake request, clear order) that is not valid JSON, whose `version` is not `1`, or whose other fields are not in the form stated for it, is treated as absent; the tool that would write such a file writes over it. A session ID that contains anything but letters, digits and hyphens names no wake request and no clear order.
- Each file is replaced atomically when it is written.

### Installation at user scope

The plugin's directory is `plugin/` in the repository. The repository holds a marketplace, also named `cc-session-pool`, that lists the plugin by that relative path. The installation of claude-session-pool-plugin::CON-001/AC-02 is two commands, each run once: `claude plugin marketplace add <absolute path of the repository>`, then `claude plugin install cc-session-pool@cc-session-pool`. It is removed with `claude plugin uninstall cc-session-pool@cc-session-pool` and `claude plugin marketplace remove cc-session-pool`.

The plugin's entry for the server runs `node` with the server's entry file in the repository, sets `alwaysLoad` to true, and sets `timeout` to 86400000 milliseconds. Claude Code applies `timeout` as the wall-clock limit of one tool call and raises the time a call may stay silent to at least that value, so a `compact` wait is not cut short at Claude Code's default of 30 silent minutes. No tool call can outlast 24 hours.

### Facts about Claude Code the plugin rests on

- **Plugins.** A plugin installed at user scope is loaded by every session of that user, in every project, unless a setting disables it for that project or that session. When a marketplace that was added from a local directory lists a plugin by a relative path, Claude Code uses the plugin's files in place and reads them at every session start. A plugin given with `--plugin-dir` is loaded for that session only, and takes the place of an installed plugin of the same name there. A tool of a plugin's server is offered under the name `mcp__plugin_<plugin>_<server>__<tool>`.
- **Server and hook processes.** Claude Code starts one server process for each session that loads the server. The attached session is the live entry of the session listing ([claude-session-pool](claude-session-pool.md)) whose `pid` is the server's parent process. A server process and a hook process each start with the environment variables of their session, and their parent process is the session's process. For a hook that holds when its declaration gives the program and its arguments separately, so that no shell runs in between.
- **`SessionStart` hooks.** Claude Code runs a plugin's `SessionStart` hooks when a session starts or is resumed, after `/clear` and after every compaction. They receive the session's `session_id`.
- **Mods.** A plugin's hooks file can name a hooks module beside its command hooks; Claude Code loads that module, the plugin's mod, into the session's own process, in a session that is not interactive as well. Claude Code tells the mod when a session starts and whether it is interactive. It tells the mod of each tool call before the tool runs, a call to a tool of the plugin's server included, under the tool's full name and with the ID of the subagent that made it, if one did; the mod can return the result itself, and the tool then does not run. It tells the mod when a turn of the session starts and when it ends, and why it ended: with the model's answer, because the user interrupted it, on a refusal by the model, or on an API error. The mod can read and write files under the user's home directory. Claude Code's validator for plugins accepts a mod only when it passes the interface Claude Code hands it to functions declared at the top of the module. Claude Code loads the mod again when a file under a directory given with `--plugin-dir` is saved; whether it does so for an installed plugin that it uses in place has not been measured. Measured on Claude Code 2.1.322.

## Out of Scope

- **Installing the plugin from anywhere but the repository on this Mac.** A marketplace on a git host, or any other source from which Claude Code copies the plugin's directory, is not supported.
