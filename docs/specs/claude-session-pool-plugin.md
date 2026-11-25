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

### claude-session-pool-plugin::REQ-004 The mod looks once a minute (direct acceptance)

In every interactive session in which the mod runs, the mod makes a look every 60 seconds, counted from the moment Claude Code loads it, whether or not a turn is running in the session. What it does at a look is stated in [claude-session-pool-subagent-watch](claude-session-pool-subagent-watch.md) and in claude-session-pool-plugin::REQ-007/AC-02 and claude-session-pool-plugin::REQ-008/AC-01.

### claude-session-pool-plugin::REQ-005 A report of the mod starts one turn

- claude-session-pool-plugin::REQ-005/AC-01: The mod makes a report by submitting its text to the session as a prompt, at a look at which no turn is running in the session. Nothing is typed into a window. The lines that are due for one feature at one look make one report.
- claude-session-pool-plugin::REQ-005/AC-02: At a look at which a turn is running in the session, the mod holds a request for a compaction ([claude-session-pool-compact-self](claude-session-pool-compact-self.md), "The mod's part"), a compaction it asked for is running, or a report it submitted has not been answered yet, the mod submits nothing. What was due stays due, and is reported at the first later look at which none of the four holds and which still finds it.
- claude-session-pool-plugin::REQ-005/AC-03: When Claude Code does not take the prompt, the report counts as not made, and what was due stays due as claude-session-pool-plugin::REQ-005/AC-02 states.
- claude-session-pool-plugin::REQ-005/AC-04: The text of a report is made of fixed sentences, which the feature states. Its first line says that the cc-session-pool plugin wrote it and that it is not a message from the user.

### claude-session-pool-plugin::REQ-006 A condition is reported once (direct acceptance)

Each condition that a feature reports is reported once, for as long as it lasts. A condition that ended and is found again is a new condition.

### claude-session-pool-plugin::REQ-007 What the mod counts as progress

- claude-session-pool-plugin::REQ-007/AC-01: A look finds progress in a subagent of the session when the size of its transcript, or the token count that Claude Code reports for it, differs from what the look before found. Where the size cannot be read, the token count alone counts.
- claude-session-pool-plugin::REQ-007/AC-02: The mod finds progress in its session when a turn of the main conversation starts or ends, when a tool call of the main conversation starts or returns, when a look finds that the token count of the session's context differs from what the look before found, and when a look finds progress in a subagent (claude-session-pool-plugin::REQ-007/AC-01). Nothing else counts as progress.

### claude-session-pool-plugin::REQ-008 Every interactive session records its activity

- claude-session-pool-plugin::REQ-008/AC-01: In every interactive session in which the mod runs, the mod writes the session's activity record ("State files") when Claude Code loads it and at every look, for the session's present session ID.
- claude-session-pool-plugin::REQ-008/AC-02: The record states whether a turn of the main conversation is running; when the last turn of the conversation with that session ID ended, of the turns the mod has been told of since Claude Code loaded it, never taking the time from a standing record, at load or when the session goes to another conversation; whether a turn has started in that conversation; which tool call of the main conversation has been running longest and since when; and when the mod last found progress in the session (claude-session-pool-plugin::REQ-007/AC-02), which is the time Claude Code loaded the mod until the mod finds progress.
- claude-session-pool-plugin::REQ-008/AC-03: A record that says a turn has started in the conversation goes on saying so for that session ID: the first time the mod writes the record of a session ID after Claude Code has loaded the mod, at load or when the session goes to another conversation, as by `/resume`, it takes this from the record that stands for that session ID.
- claude-session-pool-plugin::REQ-008/AC-04: When it runs, the plugin's `SessionStart` hook also deletes every activity record that was written more than 24 hours before, judged by the time its file was last modified.

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
- **The mod is loaded again**, as when the session is restarted or a file of the plugin is saved: the looks start anew, and nothing the mod counted or reported before is kept but what claude-session-pool-plugin::REQ-008/AC-03 states.
- **The owner has stopped the session and typed nothing since**: Claude Code takes no prompt from the mod, so every report waits (claude-session-pool-plugin::REQ-005/AC-03) until the owner sends input.
- **The session is not interactive, or its Claude Code does not load the mod**: no look is made and nothing is reported.

## Implementation Decisions

### Hooks and the mod

The plugin declares two command hooks, each run with `node` and with its program and arguments given separately: one on `SessionStart` (claude-session-pool-plugin::REQ-001 and claude-session-pool-plugin::REQ-008/AC-04), and one on `PostCompact` that [claude-session-pool-compact-self](claude-session-pool-compact-self.md) describes. The plugin's hooks file names one hooks module, the mod, beside them.

### State files

The files of the plugin lie under `~/.claude-session-pool/`: `pools/` holds rosters ([claude-session-pool](claude-session-pool.md)), `hooks/` hook records, `wake-requests/` wake requests ([claude-session-pool-compact-self](claude-session-pool-compact-self.md)), `clear-orders/` clear orders ([claude-session-pool](claude-session-pool.md)) and `activity/` activity records.

- A hook record is the file `~/.claude-session-pool/hooks/<pid>.json`, where `<pid>` is the process ID of the session, which is the hook's parent process. Content: a JSON object with `version` (the number `1`), `pid` and `sessionId`, the session ID the hook received.
- A file of the three kinds that a hook, the server and the mod write for one another (hook record, wake request, clear order) that is not valid JSON, whose `version` is not `1`, or whose other fields are not in the form stated for it, is treated as absent; the tool that would write such a file writes over it. A session ID that contains anything but letters, digits and hyphens names no wake request, no clear order and no activity record.
- Each file of those three kinds is replaced atomically when it is written.
- An activity record is the file `~/.claude-session-pool/activity/<sessionId>.json`, which the mod writes and does not replace atomically. Content: a JSON object with `version` (the number `1`), `sessionId`, `writtenAt`, `turnRunning` (a boolean), `worked` (a boolean: whether a turn has started in the conversation), `progressAt`, and, where there is one, `lastTurnEndedAt` and `toolCall`, an object with `tool`, the tool's name as Claude Code gives it, and `startedAt`. Every time is in ISO 8601 form in UTC. A reader treats a record that is not in this form, or whose `sessionId` is not that of its file name, as absent.

### Installation at user scope

The plugin's directory is `plugin/` in the repository. The repository holds a marketplace, also named `cc-session-pool`, that lists the plugin by that relative path. The installation of claude-session-pool-plugin::CON-001/AC-02 is two commands, each run once: `claude plugin marketplace add <absolute path of the repository>`, then `claude plugin install cc-session-pool@cc-session-pool`. It is removed with `claude plugin uninstall cc-session-pool@cc-session-pool` and `claude plugin marketplace remove cc-session-pool`.

The plugin's entry for the server runs `node` with the server's entry file in the repository, sets `alwaysLoad` to true, and sets `timeout` to 86400000 milliseconds. Claude Code applies `timeout` as the wall-clock limit of one tool call and raises the time a call may stay silent to at least that value, so a `compact` wait is not cut short at Claude Code's default of 30 silent minutes. No tool call can outlast 24 hours.

### Facts about Claude Code the plugin rests on

- **Plugins.** A plugin installed at user scope is loaded by every session of that user, in every project, unless a setting disables it for that project or that session. When a marketplace that was added from a local directory lists a plugin by a relative path, Claude Code uses the plugin's files in place and reads them at every session start. A plugin given with `--plugin-dir` is loaded for that session only, and takes the place of an installed plugin of the same name there. A tool of a plugin's server is offered under the name `mcp__plugin_<plugin>_<server>__<tool>`.
- **Server and hook processes.** Claude Code starts one server process for each session that loads the server. The attached session is the live entry of the session listing ([claude-session-pool](claude-session-pool.md)) whose `pid` is the server's parent process. A server process and a hook process each start with the environment variables of their session, and their parent process is the session's process. For a hook that holds when its declaration gives the program and its arguments separately, so that no shell runs in between.
- **`SessionStart` hooks.** Claude Code runs a plugin's `SessionStart` hooks when a session starts or is resumed, after `/clear` and after every compaction. They receive the session's `session_id`.
- **Mods.** A plugin's hooks file can name a hooks module beside its command hooks; Claude Code loads that module, the plugin's mod, into the session's own process, in a session that is not interactive as well. Claude Code tells the mod when a session starts and whether it is interactive. It tells the mod of each tool call before the tool runs, a call to a tool of the plugin's server included, under the tool's full name and with the ID of the subagent that made it, if one did; the mod can return the result itself, and the tool then does not run. It tells the mod when a turn of the session starts and when it ends, and why it ended: with the model's answer, because the user interrupted it, on a refusal by the model, or on an API error. The mod can read and write files under the user's home directory; a file it writes is written in place, and the directories its path needs are made. The interface Claude Code hands a mod renames and deletes no file, so the mod could replace a file atomically only by running a command, which it does not do (measured on Claude Code 2.1.327). Claude Code's validator for plugins accepts a mod only when it passes the interface Claude Code hands it to functions declared at the top of the module. Claude Code loads the mod again when a file under a directory given with `--plugin-dir` is saved; whether it does so for an installed plugin that it uses in place has not been measured. Measured on Claude Code 2.1.322.
- **A mod's timer and prompt.** A timer that the mod sets at its start fires at its interval while no turn is running in the session as well as during one, a tool call that is still running included, with no model request; when Claude Code loads the mod again, the earlier timer stops and the mod is started again. The mod is told when a turn of the main conversation starts, without a subagent's ID, and when a turn of a subagent starts, with its ID; a task notification starts a turn of the main conversation. The mod learns that a tool call it was told of has returned when the call's result comes back to it: of calls made side by side it is told of each before either returns, a call that waits on the user's permission is told before the user is asked and returns after the answer, and a call that starts a subagent in the background returns at once. `/clear` tells the mod of no turn start, and does not tell it that the session started, although the plugin's `SessionStart` hooks run again; the mod learns the new session ID when it next asks for it. A `/resume` within the session does the same, and Claude Code does not load the mod again for it. A tool call that the user interrupts, while it runs or while it waits on the user's permission, returns, and the turn ends because the user interrupted it. The token count of the session's context is the input figure that [claude-session-pool-context-usage](claude-session-pool-context-usage.md) reports ("The context figures"); it changes within a turn, and Claude Code has none after `/clear` until the next model response. Claude Code answers a prompt that the mod submits with the prompt once the turn it starts has begun, and with a reason when it does not take it, as when the owner stopped the session and nobody has sent input since. Measured on Claude Code 2.1.327.

## Out of Scope

- **Installing the plugin from anywhere but the repository on this Mac.** A marketplace on a git host, or any other source from which Claude Code copies the plugin's directory, is not supported.
