# claude-session-pool

> Related: [ADR-0001](../adr/0001-interactive-terminal-worker-sessions.md), [ADR-0002](../adr/0002-wake-by-hook-plugin-delivery.md)

## Problem Statement

A dispatcher session hands tickets to worker sessions and receives their reports through cross-session messages. It cannot create a worker session, and neither it nor a worker session can run `/clear` or `/compact`. The owner therefore opens every worker session by hand, types `/clear` into it after each ticket and `/compact` before each pull request, and tells the dispatcher session when that is done. Whenever the owner is away, the run stops.

No session can compact its own conversation either: a session that should carry on with less context stops and waits for the owner to type `/compact` and then to tell it to go on.

A session cannot see the size of its own context. Claude Code's status line shows it to the owner and not to the model, so a session whose instructions make compacting depend on that size works it out from its own transcript, a file Claude Code does not document as a stable interface, or does not know it.

Each time the dispatcher session is restarted, Claude Code gives it a new generated name, and the reports its worker sessions address to the old name no longer arrive.

## Solution

A Claude Code plugin that carries an MCP server, two hooks and a mod. The server offers two levels of access.

To the dispatcher session it offers the tools that manage a pool. Through them the dispatcher session opens worker sessions in Terminal windows, registers ones the owner opened, resets or compacts a worker session's conversation by typing the command into its window, reads the real state of every slot, closes or replaces a worker session, and takes a slot off the roster.

To every session that has the server, the dispatcher session included, it offers one tool with which the session compacts its own conversation; when the compaction has finished, the session is woken so that it carries on. Where the plugin's mod runs in the session, the mod compacts the conversation and wakes the session, and nothing is typed. In any other session the server types `/compact` into the session's Terminal window, and a hook of the plugin wakes the session.

Where the plugin's mod runs, every session, the dispatcher session included, also has a tool that reports the size of its own context as Claude Code's status line has it: the input tokens of its latest model request, the context window of its model, and the share of the window they fill. A session in which the mod does not run has no such tool.

The dispatcher session is the one started through the repository's start-up command, which also keeps that session under one name across restarts. Sessions get the plugin from one installation that the owner makes; the start-up command loads it for the dispatcher session where that installation does not reach it. Apart from starting the dispatcher session and making that installation, nothing described above needs the owner.

## User Stories

### claude-session-pool::US-001 Build a pool without the owner

As a dispatcher session, I open the worker sessions I need myself, so that a run can start and grow without the owner opening windows.

- claude-session-pool::US-001/AC-01: When no live session on this Mac answers to the given name, `open` opens a new Terminal window, starts an interactive Claude Code session in it in the pool directory under that name, waits until that session is idle, adds the name to the roster as a slot, and returns the slot's name and session ID.
- claude-session-pool::US-001/AC-02: A session opened without a `model` argument runs the model alias `opus`, and one opened without a `permissionMode` argument starts in `auto` mode. When either argument is given, the session starts with the given value instead.
- claude-session-pool::US-001/AC-03: The Terminal window that was frontmost before `open` was called is the frontmost Terminal window when `open` returns.
- claude-session-pool::US-001/AC-04: `init` takes a list of names and opens each one in order as `open` does. A name that fails does not stop the names after it, and the result states the outcome for every name.
- claude-session-pool::US-001/AC-05: When a live session on this Mac already answers to the name, in any directory, `open` refuses, opens no window and leaves the roster unchanged.
- claude-session-pool::US-001/AC-06: When the new session is not idle 60 seconds after its window opened, `open` returns an error that includes the last lines visible in that window, leaves the window open, and does not add the name to the roster.

### claude-session-pool::US-002 Take over sessions the owner opened

As a dispatcher session, I register worker sessions the owner opened by hand, so that I can manage them with the same tools as the ones I opened.

- claude-session-pool::US-002/AC-01: When exactly one live interactive session in the pool directory answers to the name, it runs in a Terminal window and it is not the dispatcher session, `adopt` adds the name to the roster as a slot and changes nothing in that session.
- claude-session-pool::US-002/AC-02: `adopt` refuses, and leaves the roster unchanged, in each of these cases: no live interactive session answers to the name; the only sessions that answer to it run in another directory; more than one session in the pool directory answers to it; the session is the dispatcher session; the session does not run in a Terminal window.
- claude-session-pool::US-002/AC-03: `adopt` on a name that is already a slot succeeds and changes nothing.

### claude-session-pool::US-003 Start a slot from an empty conversation

As a dispatcher session, I reset a worker session's conversation when its ticket is done, so that the next ticket starts with empty context and the owner does not type `/clear`.

- claude-session-pool::US-003/AC-01: `clear` on a slot delivers `/clear` as a typed command under claude-session-pool::REQ-002 and returns once the slot's session ID has changed. The result states the old and the new session ID. The slot keeps its name, its Terminal window and its process.
- claude-session-pool::US-003/AC-02: When the session ID has not changed 30 seconds after the command was typed, `clear` returns an error stating that the command was typed and not confirmed. It does not type again.

### claude-session-pool::US-004 Shrink a slot's conversation before its pull request

As a dispatcher session, I compact a worker session's conversation and learn when the compaction has finished, so that the owner neither types `/compact` nor tells me it is done.

- claude-session-pool::US-004/AC-01: `compact` on a slot delivers `/compact` as a typed command under claude-session-pool::REQ-002 and returns success only after the session's transcript shows a compaction recorded after the command was typed. The slot's session ID is unchanged.
- claude-session-pool::US-004/AC-02: When the command had no visible effect, `compact` returns the result "unconfirmed" and the reason without waiting for the time limit. That is the case when the session has not become busy 20 seconds after the command was typed, and when it became busy, returned to idle, and its transcript shows no such compaction 10 seconds later.
- claude-session-pool::US-004/AC-03: When no compaction is recorded within the time limit, `compact` returns the result "unconfirmed" and does not type again. The time limit is 30 minutes unless the `timeoutMinutes` argument gives another value.
- claude-session-pool::US-004/AC-04: When the session's transcript cannot be found or read, `compact` still types the command and then returns at once with the result "unconfirmed" and that reason.
- claude-session-pool::US-004/AC-05: While a `compact` call is waiting, calls to the other tools, and to `compact` on another slot, are answered without waiting for it.

### claude-session-pool::US-005 See the pool's real state

As a dispatcher session, I read the current state of every slot, so that I notice a worker session that is stuck on a prompt or has disappeared.

- claude-session-pool::US-005/AC-01: `status` lists every slot in the roster with its state and, for a live slot, its session ID. The state is one of `idle`, `busy`, `waiting`, `gone` and `ambiguous`; for `waiting` it also states what the session is waiting for, as Claude Code reports it.
- claude-session-pool::US-005/AC-02: A slot that no live interactive session in the pool directory answers to is listed as `gone` and stays in the roster.
- claude-session-pool::US-005/AC-03: A slot that more than one live interactive session in the pool directory answers to is listed as `ambiguous`.

### claude-session-pool::US-006 Close or replace a worker session

As a dispatcher session, I close a worker session I no longer need and replace one that is stuck, so that the owner does not close windows or restart sessions.

- claude-session-pool::US-006/AC-01: `close` on an idle slot ends its session's process, waits for the process to exit, and removes the slot from the roster. When the session it ended is the one the server opened for the slot, and its Terminal window has no other tab, `close` also closes that window.
- claude-session-pool::US-006/AC-02: `close` leaves the Terminal window open, and says so in its result, in each of these cases: the server adopted the slot; the owner started the slot's session by hand after the one the server opened had ended; the window has other tabs, in which case the session's tab stays in it.
- claude-session-pool::US-006/AC-03: `close` on a slot that is `busy` or `waiting` refuses and states the slot's state, unless the `force` argument is true; with `force` true it proceeds as for an idle slot.
- claude-session-pool::US-006/AC-04: `close` on a `gone` slot removes it from the roster and succeeds.
- claude-session-pool::US-006/AC-05: When the session's process has not exited 15 seconds after `close` asked it to end, `close` returns an error, keeps the slot in the roster, and closes no window. This holds with `force` true as well.
- claude-session-pool::US-006/AC-06: `recycle` closes the slot as `close` does, with the same `force` rule, and then opens a new worker session under the same name as `open` does; it takes the `model` and `permissionMode` arguments of `open`, with the same defaults. The slot then holds a new process and a new conversation.
- claude-session-pool::US-006/AC-07: When the close step of `recycle` refuses or fails, nothing is opened. When the close step succeeds and the open step fails, the slot stays in the roster and the error states the slot's state at that moment: `gone` when no new session exists, `busy` or `waiting` when one started and was not idle within 60 seconds. In the second case the new session's window counts as opened by the server.

### claude-session-pool::US-007 Undo a registration

As a dispatcher session, I take a slot off the roster and leave its session as it is, so that a wrong `adopt` or `open` can be undone without ending anyone's work.

- claude-session-pool::US-007/AC-01: `release` removes the slot from the roster, whatever the slot's state, and does not type into, end or close anything.

### claude-session-pool::US-008 Compact my own conversation and carry on

As a session, I compact my own conversation when I judge it is time and continue afterwards, so that the owner neither types `/compact` into my window nor tells me to go on.

A call to `compact_self` is handled in one of two ways, and claude-session-pool::US-008/AC-08 states which. claude-session-pool::US-008/AC-01 to claude-session-pool::US-008/AC-07 describe a call the server handles, apart from the first sentence of AC-01, which holds for every call. claude-session-pool::US-008/AC-09 to claude-session-pool::US-008/AC-14 describe a call the mod answers.

- claude-session-pool::US-008/AC-01: `compact_self` takes no arguments and acts on no session but the attached session. When the server handles the call, it types `/compact` into the Terminal tab that hosts the attached session, without bringing that window to the front and without interrupting the turn in progress.
- claude-session-pool::US-008/AC-02: Before it types, `compact_self` leaves a wake request for the attached session's conversation. It returns success once the session's transcript shows `/compact` queued on its own. The result states that the command runs when the current turn ends and that the session is woken after the compaction.
- claude-session-pool::US-008/AC-03: When the transcript shows the command queued as part of a longer text, which happens when text was sitting in the session's input box, `compact_self` returns an error that quotes the queued text and states that no compaction will run. It withdraws the wake request, so nothing wakes the session later.
- claude-session-pool::US-008/AC-04: When the transcript shows nothing queued 10 seconds after the typing, `compact_self` returns the result "unconfirmed". The wake request stays, so a compaction that the command starts later still wakes the session.
- claude-session-pool::US-008/AC-05: When a compaction started by `/compact` finishes in a session whose conversation has a wake request, the plugin's hook wakes the session: the session starts a turn with nothing typed into its window, and the model is handed the sentence `The compaction this session requested with compact_self has finished. This is not an error. Continue the work that was in progress.` That uses the request up. The sentence is always the same; the tool accepts no text to hand over.
- claude-session-pool::US-008/AC-06: `compact_self` refuses, types nothing and leaves no wake request in each of these cases: the attached session is not listed as a live interactive session; its state is not `busy`, in which case the error states the state and, for `waiting`, what the session is waiting for; its transcript cannot be found or read; no Terminal tab hosts it; no hook record shows that the plugin's hooks run in the attached session; the session's conversation has a wake request that was left less than 30 minutes ago.
- claude-session-pool::US-008/AC-07: A wake request does not lapse. Unless the `compact_self` call that left it withdraws it before returning, it stays until a compaction finishes in that conversation that `/compact` started, whoever typed the command, or that the mod asked for (claude-session-pool::US-008/AC-09), or until a later `compact_self` call replaces it, which claude-session-pool::US-008/AC-06 allows once it is 30 minutes old. The hook wakes no session after a compaction Claude Code started on its own, and none whose conversation has no wake request. A wake request belongs to one conversation: after `/clear` the session has a new session ID, and the request left for the old one no longer applies to it.
- claude-session-pool::US-008/AC-08: In an interactive session in which the plugin's mod runs, the mod answers a call to `compact_self` in the server's place: the server's tool does not run, nothing is typed, and no wake request is left. The refusals of claude-session-pool::US-008/AC-06 do not apply to such a call; in particular the session need not run in a Terminal window. The result states that the conversation is compacted when the current turn ends and that the session is woken after the compaction. In every other session the call reaches the server.
- claude-session-pool::US-008/AC-09: When the turn in which the call was made ends with the model's answer, the mod has Claude Code compact the attached session's conversation, with nothing typed. When the compaction has finished, the mod starts a turn in the session, and the model is handed the sentence of claude-session-pool::US-008/AC-05; the plugin's hook does not wake the session after this compaction. When the conversation has a wake request, which an earlier call the server handled left (claude-session-pool::US-008/AC-04, claude-session-pool::US-008/AC-07), the mod starts no turn after the compaction, and the plugin's hook wakes the session instead, as claude-session-pool::US-008/AC-05 states, which uses the request up. Either way the session starts one turn, not two.
- claude-session-pool::US-008/AC-10: When Claude Code refuses the compaction because a turn is in progress, the mod asks again 2 seconds later, up to 5 times. When the last of these is refused for the same reason, the request stands, and the mod treats the end of the session's next turn as claude-session-pool::US-008/AC-09 and claude-session-pool::US-008/AC-12 state for the turn of the call.
- claude-session-pool::US-008/AC-11: When the compaction does not complete for any other reason (Claude Code refuses it, it fails, or a hook vetoes it), the mod starts a turn in the session, and the model is handed the sentence `The compaction this session requested with compact_self did not complete: <reason>. Continue the work that was in progress, and do not call compact_self again in this turn.`, in which `<reason>` is what Claude Code reported. The request is used up, and the mod does not ask again.
- claude-session-pool::US-008/AC-12: The mod drops the request, compacts nothing and starts no turn in each of these cases: the turn at whose end the compaction was due ended because the owner interrupted it; that turn ended on an API error or on a refusal by the model; the session's conversation was cleared before the compaction ran. When the owner cancels the compaction while it runs, the mod does not ask again and starts no turn.
- claude-session-pool::US-008/AC-13: A call that a subagent of the session makes is refused by the mod with an error stating that only the session itself can call `compact_self`. It leaves no request, and it does not reach the server.
- claude-session-pool::US-008/AC-14: A call made while a request of the same conversation stands is answered as the first one was and changes nothing else: the conversation is compacted once.

### claude-session-pool::US-009 One name for the dispatcher session across restarts

As the owner, I start and resume the dispatcher session through the start-up command and it keeps one name, so that worker sessions keep reporting to a name that still answers.

- claude-session-pool::US-009/AC-01: When its arguments start a new interactive session and give no name, the start-up command starts the session under the default name: the name of the directory the command is run in, followed by `-dispatcher`.
- claude-session-pool::US-009/AC-02: When its arguments resume a session by session ID and that session's transcript shows a name that was given to it, the command adds no name, and the session keeps the name it has.
- claude-session-pool::US-009/AC-03: When its arguments resume a session by session ID and that session's transcript shows no such name, the command starts the session under the default name.
- claude-session-pool::US-009/AC-04: Before it uses the default name, the command lists the live sessions on this Mac. When one of them already answers to the default name, in any directory, the command starts nothing and prints that session's process ID and directory and the advice to pass `-n` with another name. When the sessions cannot be listed, it starts nothing and prints the reason and the same advice.
- claude-session-pool::US-009/AC-05: The command adds no name and lists no sessions in each of these cases: the arguments give a name with `-n` or `--name`, which is used as given; they resume a session and the command cannot tell from them which local transcript is that session's, that is `-c`, `--continue`, `--from-pr`, `--teleport`, or `-r` or `--resume` with no value or with a value that is not a session ID; they contain `--fork-session`; they start no new interactive session in the terminal the command is run in, that is they contain `-p`, `--print`, `--bg`, `--background`, `--cloud`, `--environment`, `--desktop`, `-h`, `--help`, `-v` or `--version`. An option that begins with two hyphens is also recognised with a value attached to it by `=`, as in `--name=<name>`.
- claude-session-pool::US-009/AC-06: When the arguments resume a session by session ID and that session's transcript cannot be found or read, the command adds no name, prints one line that says so, and starts the session.
- claude-session-pool::US-009/AC-07: In the directory `/`, which has no name, the command builds no default name: where this story calls for one, it starts nothing and prints the advice to pass `-n`.

### claude-session-pool::US-010 Know the size of my own context

As a session, I learn the size of my own context when I need it, so that I decide whether to compact from the figure Claude Code itself has, without working it out from my transcript.

- claude-session-pool::US-010/AC-01: In a session in which the plugin's mod runs, interactive or not, the mod offers the tool `context_usage` from the start of the session, with its definition in the tool list, so the session calls it without first searching for it. The tool takes no arguments and reports on no session but the one that calls it. A session in which the mod does not run has no such tool: the server offers none.
- claude-session-pool::US-010/AC-02: `context_usage` returns three figures as Claude Code's status line has them when the call is made: the input tokens of the session's latest model request, uncached, cache-written and cache-read together, which is the request that made the call; the context window of the session's model, in tokens; and the share of the window those input tokens fill, as a whole percentage.
- claude-session-pool::US-010/AC-03: When Claude Code has no input figure or no share for the session, `context_usage` returns an error stating that the size of the context is not known, and gives no figure.
- claude-session-pool::US-010/AC-04: When Claude Code fails to report the figures, `context_usage` returns an error that states the reason Claude Code gave, and gives no figure.
- claude-session-pool::US-010/AC-05: A call that a subagent of the session makes is refused with an error stating that only the session itself can call `context_usage`. It gives no figure.

## Functional Requirements

### claude-session-pool::REQ-001 Only slots, and never the dispatcher session

- claude-session-pool::REQ-001/AC-01: `clear`, `compact`, `close`, `recycle` and `release` refuse a name that is not a slot in the roster, and act on no session.
- claude-session-pool::REQ-001/AC-02: No tool types into, ends or registers the dispatcher session, with one exception: `compact_self` called by the dispatcher session compacts the dispatcher session under claude-session-pool::US-008, and types into it where the server handles the call.

### claude-session-pool::REQ-002 Delivering a typed command

- claude-session-pool::REQ-002/AC-01: A typed command is typed only while the slot's session is idle. When it is not idle, the tool waits up to 60 seconds for it to become idle; if it is still not idle, the tool refuses, types nothing, and states the slot's state and what it is waiting for.
- claude-session-pool::REQ-002/AC-02: Text that is sitting in the session's input box when the command is typed is discarded. It is not submitted as a message, and the command still runs.
- claude-session-pool::REQ-002/AC-03: The command is typed into the Terminal tab that hosts the slot's session, without bringing that window to the front. When no such tab is found, or the slot is `gone` or `ambiguous`, the tool refuses and types nothing.

### claude-session-pool::REQ-003 One pool per directory (direct acceptance)

The pool directory is the directory the dispatcher session was started in; every session the server opens starts in that directory, and two dispatcher sessions started in different directories have separate rosters.

### claude-session-pool::REQ-004 The roster outlives the server process (direct acceptance)

A slot added by one server process is a slot for the next server process started in the same directory, including after the dispatcher session is restarted.

### claude-session-pool::REQ-005 Refusals and failures are reported, not hidden

- claude-session-pool::REQ-005/AC-01: Every refusal and failure is returned as a tool error whose text states the reason and the state the server observed; no tool reports success for a step it did not confirm.
- claude-session-pool::REQ-005/AC-02: When a step that cannot be taken back has been done (a window opened, a command typed, a session ended) and what follows fails, the error says that the step was done.
- claude-session-pool::REQ-005/AC-03: A session listing that fails while a tool waits after such a step does not end the wait. The wait goes on to its limit, and an error at the limit includes the listing's error.
- claude-session-pool::REQ-005/AC-04: When the slot's session disappears, or another process comes to answer to the slot's name, while `clear` or `compact` waits, the tool returns at once and states the slot's state.

### claude-session-pool::REQ-006 What the server offers depends on how the session was started

- claude-session-pool::REQ-006/AC-01: To a dispatcher session the server offers `init`, `open`, `adopt`, `status`, `clear`, `compact`, `close`, `recycle`, `release` and `compact_self`.
- claude-session-pool::REQ-006/AC-02: To any other attached session the server offers `compact_self` alone. The other nine tools are not listed there, and a call to one of them is answered with an error and does nothing.
- claude-session-pool::REQ-006/AC-03: A session is a dispatcher session only when the start-up command started it. A worker session the server opened, a session started with `claude` directly, and a session started from inside a dispatcher session are not dispatcher sessions.

## Constraints

### claude-session-pool::CON-001 Terminal on macOS only (direct acceptance)

Applies to: the nine tools that manage a pool, and a `compact_self` call the server handles; worker sessions run in windows of the macOS Terminal application (ADR-0001), and a session in any other terminal, or a background session, cannot be opened, adopted or typed into. A `compact_self` call the mod answers (claude-session-pool::US-008/AC-08) types nothing and is not bound to Terminal.

### claude-session-pool::CON-002 How the server, the hooks and the mod reach a session

Applies to: installation and start-up. The decision and the options it rejected are in ADR-0002.

- claude-session-pool::CON-002/AC-01: The server, the hooks and the mod are one Claude Code plugin, named `cc-session-pool`, in which the server is named `pool`. The repository provides one start-up command. It starts a Claude Code session, passing its arguments on to `claude`, gives that session the plugin as claude-session-pool::CON-002/AC-04 states, and marks it as a dispatcher session. It changes no user-level or project-level configuration. The tool definitions are loaded up front, so the session calls a tool without first searching for it.
- claude-session-pool::CON-002/AC-02: A session the start-up command did not start has the server, the hooks and the mod only when the plugin is installed at user scope. With that installation every Claude Code session of this user on this Mac loads the plugin, in any directory, unless a setting disables it there. The owner installs it once; neither the server nor the start-up command installs, changes or removes it.
- claude-session-pool::CON-002/AC-03: A session the start-up command starts while the plugin is installed is offered the ten tools of claude-session-pool::REQ-006/AC-01, each of them once and under the same names as without the installation; each hook runs there once for an event, and the mod answers a call to `compact_self` once and offers `context_usage` once.
- claude-session-pool::CON-002/AC-04: Before it starts the session, the start-up command finds out whether the plugin is installed and enabled in the directory it is run in, from the plugin's directory of the repository the command belongs to. When it is, the command does not load the plugin itself, and the session gets it from the installation. In every other case it loads the plugin from that directory for the session only: when the plugin is not installed; when it is installed and not enabled in that directory, by any setting; and when the installation reads another copy of the plugin, such as one in another checkout of the repository. It also loads it whenever its arguments contain `--restricted`, `--setting-sources` or `--settings`, with or without a value attached by `=`, whatever the listing shows.
- claude-session-pool::CON-002/AC-05: When the start-up command cannot find out, because the listing of installed plugins fails or its output cannot be read, it loads the plugin for the session only, as claude-session-pool::CON-002/AC-04 does when the plugin is not installed, prints one line that gives the reason, and starts the session.

### claude-session-pool::CON-003 Arguments that reach a command line are validated

Applies to: `init`, `open`, `adopt`, `clear`, `compact`, `close`, `recycle`, `release`.

- claude-session-pool::CON-003/AC-01: A slot name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; any other name is refused before anything is run.
- claude-session-pool::CON-003/AC-02: A `model` argument must match `^[A-Za-z0-9._\[\]-]{1,64}$`; any other value is refused before anything is run.
- claude-session-pool::CON-003/AC-03: A `permissionMode` argument must be one of `auto`, `acceptEdits`, `default`, `plan` and `dontAsk`. Any other value, `bypassPermissions` included, is refused before anything is run.
- claude-session-pool::CON-003/AC-04: A pool directory whose path contains spaces or quote characters is handled as that exact path.
- claude-session-pool::CON-003/AC-05: When the name of the directory the start-up command is run in contains a control character, the command does not build a default name from it: where claude-session-pool::US-009 calls for the default name, it starts nothing and prints the advice to pass `-n`.
- claude-session-pool::CON-003/AC-06: When the path of the plugin's directory contains a control character, the start-up command starts nothing, whatever arguments it was given, and prints the reason. A line break in that path would otherwise reach `claude` as further arguments.

### claude-session-pool::CON-004 Runtime (direct acceptance)

Applies to: the server process, the hook processes and the start-up command; each runs on the `node` found on the `PATH` of the session it serves, which must be Node.js 22.18 or later, with no build step.

## Failure modes and boundaries

Slot states and how a slot moves between them:

| From | To | By |
|---|---|---|
| not a slot | live (`idle`, `busy` or `waiting`) | `open`, `init`, `adopt` |
| live | not a slot | `close`, `release` |
| live | `gone` | the owner closes the window; the session crashes; the Mac restarts; the open step of `recycle` fails and no new session exists |
| `gone` | live | `open` or `recycle` under the same name; the owner starts a session under that name in the pool directory |
| `gone` | not a slot | `close`, `release` |
| live | `ambiguous` | the owner starts a second session under the same name in the pool directory |
| `ambiguous` | live | one of the two sessions ends |
| `ambiguous` | not a slot | `release` |

Boundaries and failures:

- **A message reaches a slot's session between the idle check and the typing** of a typed command. The session starts a turn, and the interrupt that discards the input box (claude-session-pool::REQ-002/AC-02) ends that turn. The server does not detect this. A tool's result still follows its own confirmation rule.
- **`clear` or `compact` on a slot that is `gone` or `ambiguous`**: refused under claude-session-pool::REQ-002/AC-03.
- **`close` or `recycle` on an `ambiguous` slot**: refused, with the number of sessions that answer to the name; `force` does not change this.
- **`open` on a name that is a `gone` slot**: allowed; the slot becomes live again. On a live slot it is refused under claude-session-pool::US-001/AC-05. When the new session is not idle within 60 seconds, the slot stays in the roster and the error says so; the roster then records the new session if it is listed, and otherwise no session.
- **Terminal cannot be scripted** (macOS refuses the automation request, or Terminal reports an error): the tool returns that error text; `open` adds no slot, and `compact_self` withdraws the wake request it left.
- **The roster file cannot be parsed, or carries a version this server does not know**: every tool other than `compact_self` refuses and names the file; the file is not rewritten. `compact_self` does not read the roster.
- **Two calls arrive at the same time**: among the nine tools other than `compact_self`, typing into Terminal and updating the roster happen one call at a time, so two calls never interleave keystrokes or lose a roster update. Of two `open` calls for one name, one proceeds and the other is refused without opening a window. Two `adopt` calls for one name register the slot once. `compact_self` does not wait for those calls: it types only into the tab of the attached session, into which no other tool of the same server process types (claude-session-pool::REQ-001/AC-02).
- **The window the server opened holds other tabs when `close` ends its session**: Terminal's scripting interface cannot close a single tab, and closing the window would end the other tabs, so the session's tab stays (claude-session-pool::US-006/AC-02).
- **Two dispatcher sessions are started in the same directory**: they share that directory's roster. Every call of the nine tools other than `compact_self` reads the roster file afresh, so each sees the other's changes.
- **Text read from a Terminal window** (claude-session-pool::US-001/AC-06) is returned inside the error as quoted text; the server takes no action based on it.
- **The dispatcher session ends while a `compact` call is waiting**: the wait is lost and no result is delivered; the compaction itself continues in the worker session, and a later `status` shows the slot's state.
- **A session that is asked to end holds unsaved work**: `close` does not check for it; what a worker session must have finished before it is closed is decided by the dispatcher session.
- **Text sits in the input box when `compact_self` types**: the command lands at the cursor, wherever in the text that is, and the text with the command in it is submitted as one message, which the model receives during the turn in progress; no compaction runs (claude-session-pool::US-008/AC-03). The server cannot discard the text first, because the interrupt that does so would end the turn that made the call.
- **A prompt is on screen when `compact_self` is called**, for example because another tool call of the same turn waits for a permission answer: the session's state is `waiting`, and the tool refuses (claude-session-pool::US-008/AC-06). A Return typed then would answer the prompt (see "A session's state during a tool call"). The tool reads the session's state after it has found the tab, so that it runs no other program between that reading and the typing. A prompt that comes up after that reading is not detected, and the command is typed while it is on screen.
- **The attached session does not run in a Terminal window** (another terminal application, an editor's terminal, the desktop application, a background or non-interactive session): where the mod answers the call, the session is compacted and woken (claude-session-pool::US-008/AC-08). Where it does not, the server still offers `compact_self` there, and the tool refuses (claude-session-pool::US-008/AC-06).
- **The mod does not answer `compact_self` in a session**, because the session is not interactive or its Claude Code does not load the plugin's mod: a call to `compact_self` reaches the server and is handled as claude-session-pool::US-008/AC-01 to claude-session-pool::US-008/AC-07 state. Only the tool's result tells the model which way its call was handled. Where Claude Code does not load the mod, the session also has no `context_usage` (claude-session-pool::US-010/AC-01).
- **Other tool calls are made in the same response as `context_usage`**: the figure is the input of the request that made the call (claude-session-pool::US-010/AC-02), so the results of those calls, and that of `context_usage` itself, are not in it; they count from the next request on. A large result, such as a long file read in that response, is missing from the figure until a later call.
- **Claude Code compacts the conversation on its own after `compact_self` typed the command**: the hook does not wake the session after that compaction, and the wake request stays for the one the command starts.
- **The session keeps working in the same turn after `compact_self` returned**: the command runs only when the turn ends, however much later that is, and the session is woken after the compaction (claude-session-pool::US-008/AC-07). A request the mod holds is likewise carried out only when the turn ends (claude-session-pool::US-008/AC-09).
- **Text is typed into the session during the turn of a call the mod answered**: Claude Code hands it to the model during that turn. When it is still queued as the turn ends, the mod's compaction runs first, Claude Code then starts a turn with the text, and the turn the mod starts follows that one. Either way the conversation is compacted once and the session is woken once.
- **A turn is in progress when the mod asks for the compaction**, for example because a message from another session started one as the turn of the call ended: Claude Code refuses the compaction, and claude-session-pool::US-008/AC-10 applies.
- **Claude Code compacts the conversation on its own between a call the mod answered and the end of the turn**: the mod still asks for a compaction when the turn ends. When Claude Code refuses it because too little is left to compact, claude-session-pool::US-008/AC-11 applies.
- **The session ends while the mod holds a request**: the request is kept in the session's process only, so it is gone, and a session resumed later is not compacted.
- **The mod is loaded again while it holds a request or while a compaction it asked for runs**, which Claude Code does when a file under a directory given with `--plugin-dir` is saved: what the mod held is gone. In the one run measured, a save during the turn of a call left the conversation compacted and the session not woken, and nothing reported it. A dispatcher session for which the start-up command loaded the plugin with `--plugin-dir` (claude-session-pool::CON-002/AC-04) meets this when a file under `plugin/` is changed between its call and its wake. Whether Claude Code also loads the mod again when the files of an installed plugin that it uses in place are saved has not been measured.
- **The conversation has a wake request and the plugin's hooks do not run in the session**: the mod leaves the waking to a hook that does not run, and the session stays idle after the compaction.
- **The turn the mod starts after a compaction cannot be started**, because Claude Code or another plugin's hook drops the mod's prompt: the session stays idle, and nothing reports it. Claude Code drops a plugin's prompt when the user has stopped the session and typed nothing since.
- **A `Stop` hook keeps the turn of the call from ending**: what the mod is told then has not been measured, so it is not known whether the compaction runs late, runs more than once or is dropped. The plugin declares no `Stop` hook.
- **The owner types `/compact` into a session whose conversation has a wake request**, or the dispatcher session compacts such a slot with `compact`: that compaction uses the request up, and the session is woken after it. `compact` reports its own result as it always does.
- **The dispatcher session clears a slot whose conversation has a wake request**: the session gets a new session ID, and the request no longer applies to it (claude-session-pool::US-008/AC-07).
- **The plugin's hooks do not run in a session**, for example because its settings switch all hooks off: no hook record exists for the session, and a `compact_self` call the server handles is refused (claude-session-pool::US-008/AC-06). A call the mod answers does not depend on the hooks. Hooks that are switched off after the hook record was written are not detected: the command is typed, the compaction runs, and nothing wakes the session.
- **`/clear` is followed at once by `compact_self`**: the hook record may still name the old session ID, and the tool then refuses (claude-session-pool::US-008/AC-06).
- **A wake request whose compaction never comes**, because the command was not queued after all or the session ended first: the request stays on disk and wakes nothing, unless a later compaction in the same conversation, started by `/compact` or asked for by the mod, uses it up.
- **A subagent of the session calls `compact_self`**: where the mod answers calls, it refuses this one (claude-session-pool::US-008/AC-13). The server cannot tell the call from one made by the session itself, and where it handles the call it compacts the session.
- **The `node` on a session's `PATH` is older than claude-session-pool::CON-004 requires**: the server does not start in that session, and Claude Code lists it as failed there; the hooks fail there too and write no hook record. Other sessions are not affected.
- **The owner gives the dispatcher session a name that a live session already has**: the start-up command does not check a name it was given (claude-session-pool::US-009/AC-05), and Claude Code accepts the duplicate. A message addressed to that name may then reach either session.
- **A session resumed under claude-session-pool::US-009/AC-06 had no name**: Claude Code gives it a new generated name, as it does without the start-up command.

## Implementation Decisions

### Tools

The server offers these tools, to the sessions that claude-session-pool::REQ-006 states. Because it is the server `pool` of the plugin `cc-session-pool`, a session sees each tool under the name `mcp__plugin_cc-session-pool_pool__<tool>`. Every result is text.

| Tool | Arguments |
|---|---|
| `init` | `names`: list of slot names, at least one; `model`, `permissionMode`: optional |
| `open` | `name`; `model`, `permissionMode`: optional |
| `adopt` | `name` |
| `status` | none |
| `clear` | `name` |
| `compact` | `name`; `timeoutMinutes`: optional, a positive number |
| `close` | `name`; `force`: optional boolean, default false |
| `recycle` | `name`; `force`, `model`, `permissionMode`: optional |
| `release` | `name` |
| `compact_self` | none |

Where the mod answers a call to `compact_self` (claude-session-pool::US-008/AC-08), the result is the mod's text, and the server's tool does not run.

The mod registers one tool of its own, `context_usage`, with no arguments (claude-session-pool::US-010). Claude Code offers a tool that a mod registers under the name `mcp__<plugin>__<tool>`, so a session sees it as `mcp__cc-session-pool__context_usage`, without the server's prefix. Its result is the text `Context: <tokens> input tokens of a <window>-token window (<percent>%). These are the input tokens of this session's latest model request, uncached, cache-written and cache-read together, as Claude Code's status line gives them (context_window.total_input_tokens).`, with each number written in decimal digits and no separators.

### Facts about Claude Code and Terminal the behaviour rests on

- **Session listing.** `claude agents --json` prints one entry per session. The server uses `kind` (`interactive` or `background`), `pid`, `cwd`, `name`, `sessionId`, `status` (`idle`, `busy` or `waiting`) and `waitingFor`. A live session is an entry that has a `pid`.
- **Which session a slot is.** A slot's session is the live `interactive` entry whose `name` equals the slot name and whose `cwd` is the pool directory. Directories are compared after resolving symbolic links.
- **Which session a server process is attached to.** Claude Code starts one server process for each session that loads the server. The attached session is the entry whose `pid` is the server's parent process.
- **What a server process and a hook process inherit.** Each starts with the environment variables of its session, and its parent process is the session's process. For a hook that holds when its declaration gives the program and its arguments separately, so that no shell runs in between.
- **Which session is the dispatcher session.** The start-up command sets the environment variable `CLAUDE_SESSION_POOL_DISPATCHER_PID` to its own process ID and then replaces itself with `claude`, which keeps that process ID. A server process treats its attached session as a dispatcher session only when that variable equals the process ID of its parent. A session started from inside a dispatcher session inherits the variable and has another process ID.
- **Which window hosts a session.** The session's process has a controlling terminal device; the hosting tab is the Terminal tab whose `tty` is that device.
- **Opening.** Terminal's `do script` with no target opens a new window and runs a shell command in it. The command changes to the pool directory and replaces the shell with `claude -n <name> --model <model> --permission-mode <mode>`, so that no shell is left in the tab when the session ends.
- **Typing.** Terminal's `do script <text> in <tab>` delivers the text followed by Return to the program in that tab. A typed command is the character U+0003 (Ctrl+C) followed by the command; an idle Claude Code session clears its input box on that character and stays running. Claude Code takes a long text that arrives in one piece as pasted text: it leaves the text in the input box without submitting it, and a U+0003 in front of it does not empty the box. The two texts the server types, `/clear` and `/compact`, are short enough to be taken as keystrokes.
- **Typing during a turn.** The character U+0003 ends a turn in progress, so `compact_self` types `/compact` without it. Text typed during a turn goes into the input box at the cursor, and on Return the whole content of the box is queued; the transcript records it at once as a record with `"type": "queue-operation"`, `"operation": "enqueue"` and the queued text as `content`. With `fix the typo` in the box and the cursor before `typo`, a typed `/compact` is queued as `fix the /compacttypo`. A queued slash command runs when the turn ends. A queued text that is not a slash command is handed to the model during the turn in progress, before any queued slash command runs.
- **A session's state during a tool call.** The session reports `busy` while one of its tool calls is in progress, and `waiting` while a prompt is on screen. A Return typed while a permission prompt is on screen accepts the answer the prompt highlights, which approves what the prompt asked about; text typed with it is not queued.
- **After a compaction.** A compaction started by `/compact`, or one a mod asked for, leaves the session idle; nothing continues its work until a message arrives, a hook wakes it or a mod submits a prompt.
- **Hooks around a compaction.** Claude Code runs a plugin's `SessionStart` hooks when a session starts or is resumed, after `/clear` and after every compaction, and its `PostCompact` hooks when a compaction has finished. Both receive the session's `session_id`; the `PostCompact` hooks also receive `trigger`, which is `manual` for a compaction started by `/compact` or asked for by a mod, and `auto` for one Claude Code started on its own. A command hook that is declared with `asyncRewake` and exits with code 2 makes an idle session start a turn at once. Claude Code hands the model what the hook wrote to its standard error stream, inside a system reminder that reads `Stop hook blocking error from command "PostCompact:manual": ` followed by that text; this is why the sentence of claude-session-pool::US-008/AC-05 says that it is not an error.
- **Mods.** A plugin's hooks file can name a hooks module beside its command hooks; Claude Code loads that module, the plugin's mod, into the session's own process, in a session that is not interactive as well. Claude Code tells the mod when a session starts and whether it is interactive. It tells the mod of each tool call before the tool runs, a call to a tool of the plugin's server included, under the tool's full name and with the ID of the subagent that made it, if one did; the mod can return the result itself, and the tool then does not run. It tells the mod when a turn of the session starts and when it ends, and why it ended: with the model's answer, because the user interrupted it, on a refusal by the model, or on an API error. The mod can ask Claude Code to compact the conversation. Claude Code rejects that when it is asked while the mod is answering a tool call, and while a turn or another compaction is in progress, with a message that says a conversation compacts between turns; it reports a compaction that a hook vetoed, and, when the user presses Escape during the compaction, rejects it with a message that ends in `Compaction canceled.` The mod can submit a prompt, which starts a turn once the session is idle; the model reads it as `The cc-session-pool plugin sent a message:`, the text, and a closing remark of Claude Code's that a plugin submitted this prompt between turns. Claude Code drops such a prompt when the user has stopped the session and typed nothing since. The mod can read and write files under the user's home directory. Claude Code's validator for plugins accepts a mod only when it passes the interface Claude Code hands it to functions declared at the top of the module. All of this was measured on Claude Code 2.1.322.
- **A mod's own tool and the context figures.** A mod can register a tool when it is told that the session starts. Claude Code lists the tool under `mcp__<plugin>__<name>`, in a session that is not interactive as well, puts its definition in the tool list from the start when the mod asks for that, and tells the mod of each call to it as of any other tool call. The mod can read the figures of Claude Code's status line: the input tokens of the latest response, uncached, cache-written and cache-read together (`total_input_tokens`), the context window of the session's model (`context_window_size`), and the first over the second as a whole percentage (`used_percentage`). Claude Code documents the input figure and the percentage as absent until the first response after the session started or was compacted. Read while the mod answers a tool call, the input figure is that of the request that made the call, in the middle of a turn as well. The registration and the figures were measured on Claude Code 2.1.322 in a session that was not interactive; the absence before the first response is documented, not measured.
- **Confirming a clear.** `/clear` gives the session a new `sessionId` and leaves its `pid` and `name` unchanged.
- **Confirming a compaction.** A session's transcript is the file `<sessionId>.jsonl` in a subdirectory of `~/.claude/projects/`, with one JSON object per line. A finished compaction appends a record with `"type": "system"`, `"subtype": "compact_boundary"` and a `timestamp`. A line that is still being written is not valid JSON and is not counted; the server looks only at what was appended after the command was typed. Claude Code does not document this file as a stable interface; claude-session-pool::US-004/AC-04 and claude-session-pool::US-008/AC-06 cover the case where it cannot be read. A session reports `busy` while it compacts.
- **Session names.** Claude Code gives a session that is started without a name a generated name, and generates a new one every time that session is started or resumed; the generated name is not stored. A name given with `-n` or `--name`, at a start or at a resume, or with `/rename`, is stored in the session's transcript as a record with `"type": "custom-title"` and the name as `customTitle`. Claude Code restores a stored name on every later resume and keeps it across `/clear`. A name given at a resume replaces a stored one. Claude Code accepts two live sessions under one name.
- **Session IDs.** A session ID has the form of a UUID: 8, 4, 4, 4 and 12 hexadecimal digits joined by hyphens.
- **Options of `claude` that resume a session or start none in the terminal.** By the help text of Claude Code 2.1.322: `--from-pr` resumes a session linked to a pull request; `--teleport` resumes a session that ran in the cloud; `--bg` and `--background` start the session in the background; `--cloud` and `--environment` create a cloud session, and `--cloud` can also attach to one; `--desktop` opens the session in the desktop application instead of the terminal.
- **Plugins.** A plugin installed at user scope is loaded by every session of that user, in every project, unless a setting disables it for that project or that session. When a marketplace that was added from a local directory lists a plugin by a relative path, Claude Code uses the plugin's files in place and reads them at every session start. A plugin given with `--plugin-dir` is loaded for that session only, and takes the place of an installed plugin of the same name there. A tool of a plugin's server is offered under the name `mcp__plugin_<plugin>_<server>__<tool>`.
- **Installed plugins.** `claude plugin list --json` prints a JSON list with one entry per installation. The start-up command uses `id` (`<plugin>@<marketplace>`), `enabled` and `readFromFolder`. `enabled` states whether the plugin is enabled in the directory the command is run in: a project setting that disables it there makes it `false`, and a session started there then does not load the plugin. `readFromFolder` is the directory a plugin used in place is read from. The listing does not know the options a session will be started with: a session started with `--restricted`, with `--setting-sources` that leaves out `user`, or with `--settings` that disable the plugin does not load the installed plugin although the listing shows it as enabled, and does load one given with `--plugin-dir`. Under `--strict-mcp-config`, `--safe-mode` or `--bare` a session gets the plugin's server neither way. Measured on Claude Code 2.1.322; Claude Code does not document this output as a stable interface, which claude-session-pool::CON-002/AC-05 covers.
- **Ending a session.** The server sends the session's process the termination signal; Claude Code exits on it. The server sends no other signal.
- **Closing a window.** Terminal's `close` applies to a window; a tab does not accept it. On a window whose tab runs no process it closes the window without a confirmation. A closed window can still be listed for a short time with no tabs; the server treats a window with no tabs, or one that is not visible, as closed.

### Roster file

- One file per pool: `~/.claude-session-pool/pools/<key>.json`, where `<key>` is the first 16 hexadecimal digits of the SHA-256 hash of the pool directory's absolute path after resolving symbolic links.
- Content: a JSON object with `version` (the number `1`), `directory` (that absolute path) and `slots`, a list of objects with `name` and `origin`, where `origin` is `"opened"` or `"adopted"`. An opened slot also has `pid`, the process ID of the session the server opened for it; `pid` is left out when that session was not listed within 60 seconds of its window opening. `open` and `recycle` set `origin` to `"opened"`, and `pid` to the new session's process ID when it is listed.
- The server treats a slot's window as one it opened only when the slot is `"opened"` and the live session's process ID equals `pid`. A slot without `pid` is treated as not opened by the server. That includes a window whose session was not listed within 60 seconds of its opening: when the session appears later, `close` ends it and leaves its window open.
- A missing file means an empty roster. A file whose `version` is not `1`, whose `directory` differs from the pool directory, or that is not valid JSON, is handled as the "cannot be parsed" failure above.
- The file is replaced atomically on every change.

### Hooks, hook records and wake requests

The plugin declares two command hooks, each run with `node` and with its program and arguments given separately.

- **On `SessionStart`**, for every way a session starts: the hook writes the hook record of its session. It also deletes every hook record whose process no longer runs. It writes nothing to its standard output stream, which Claude Code would add to the conversation.
- **On `PostCompact` with the matcher `manual`**, declared with `asyncRewake`: when the conversation named by `session_id` has a wake request, the hook deletes the request, writes the sentence of claude-session-pool::US-008/AC-05 to its standard error stream and exits with code 2. Otherwise it writes nothing and exits with code 0.

Given an event other than these two, or input without a session ID, the hook writes one line that begins with the plugin's name to its standard error stream and exits with code 1. That wakes no session and changes no file.

Files:

- A hook record is the file `~/.claude-session-pool/hooks/<pid>.json`, where `<pid>` is the process ID of the session, which is the hook's parent process. Content: a JSON object with `version` (the number `1`), `pid` and `sessionId`, the session ID the hook received.
- A `compact_self` call the server handles takes the plugin's hooks to run in the attached session only when the hook record named after the server's parent process exists and its `sessionId` is the attached session's present session ID. Because the `SessionStart` hook runs again after `/clear`, the record follows the conversation.
- A wake request is the file `~/.claude-session-pool/wake-requests/<sessionId>.json`. Content: a JSON object with `version` (the number `1`), `sessionId` and `requestedAt`, the time `compact_self` left it, in ISO 8601 form in UTC.
- A file of either kind that is not valid JSON, whose `version` is not `1`, or whose other fields are not in the form stated here, is treated as absent; `compact_self` writes over such a wake request. A session ID that contains anything but letters, digits and hyphens names no wake request.
- Each file is replaced atomically when it is written.

### Mod

The plugin's hooks file names one hooks module, the mod, beside the two command hooks.

- The mod answers calls to two tools: `mcp__plugin_cc-session-pool_pool__compact_self`, as claude-session-pool::US-008 states, and its own `context_usage`. Every other tool call passes through it unchanged.
- It registers `context_usage` when it is told that the session starts, interactive or not, with its definition in the tool list from the start. It answers a call with the figures it reads at that moment, takes the size as not known when the input figure or the percentage is absent, and keeps nothing between calls.
- For `compact_self`, it holds at most one request for a session, in the memory of the session's process, and writes no file. A request records the session ID of the conversation it was made in; claude-session-pool::US-008/AC-12 takes the conversation as cleared when the session has another ID at the moment the compaction is due.
- It takes a refusal of the compaction as caused by a turn in progress (claude-session-pool::US-008/AC-10) when it has been told of a turn of the session that started and has not ended, or when the refusal's message says that a conversation compacts between turns.
- It takes a refusal whose message ends in `Compaction canceled.` as the owner's cancellation (claude-session-pool::US-008/AC-12).
- Before it asks for the compaction, the mod reads the conversation's wake request, the file under `~/.claude-session-pool/wake-requests/` that the section "Hooks, hook records and wake requests" describes, and counts it only when the hook would: valid JSON in the form stated there, naming the conversation. It reads it before, because the hook deletes it as the compaction finishes. A file it cannot read counts as absent.
- A call that the mod cannot tie to a conversation, because Claude Code does not give it the session's ID, reaches the server. A session whose start the mod was not told of counts as not interactive, so its calls reach the server too.

### Time limits

| Wait | Limit |
|---|---|
| A slot becoming idle before a typed command | 60 seconds |
| A newly opened session becoming idle | 60 seconds |
| The session ID changing after `/clear` | 30 seconds |
| A session becoming busy after `/compact` | 20 seconds |
| A compaction record appearing once the session is idle again | 10 seconds |
| A compaction being recorded | 30 minutes, or `timeoutMinutes` |
| A session's process exiting | 15 seconds |
| `/compact` being shown as queued after `compact_self` typed it | 10 seconds |
| A wake request standing in the way of another `compact_self` call | 30 minutes |
| The mod asking again for a compaction that was refused because a turn was in progress | 2 seconds, up to 5 times |

### Start-up command

The start-up command of claude-session-pool::CON-002/AC-01 runs `claude` with the arguments it was given, followed by a name where claude-session-pool::US-009 calls for one, followed, where claude-session-pool::CON-002/AC-04 and claude-session-pool::CON-002/AC-05 call for it, by `--plugin-dir` and the absolute path of the plugin's directory in the repository. Before it does so it marks the session as described under "Which session is the dispatcher session".

It takes the plugin as installed and enabled (claude-session-pool::CON-002/AC-04) when `claude plugin list --json`, run in the directory the command is run in, lists an entry whose `id` is `cc-session-pool@cc-session-pool`, whose `enabled` is `true` and whose `readFromFolder` is the plugin's directory in the repository; the two directories are compared after resolving symbolic links. A listing that exits with an error or has not finished after 60 seconds fails; output that is not a JSON list, or an entry with that `id` whose `enabled` is not a boolean, is output that cannot be read (claude-session-pool::CON-002/AC-05).

The plugin's entry for the server runs `node` with the server's entry file in the repository, sets `alwaysLoad` to true, and sets `timeout` to 86400000 milliseconds. Claude Code applies `timeout` as the wall-clock limit of one tool call and raises the time a call may stay silent to at least that value, so a `compact` wait is not cut short at Claude Code's default of 30 silent minutes. No tool call can outlast 24 hours.

The command looks for the transcript of a session it resumes as the server does: the file `<sessionId>.jsonl` in a subdirectory of `~/.claude/projects/`.

### Installation at user scope

The plugin's directory is `plugin/` in the repository. The repository holds a marketplace, also named `cc-session-pool`, that lists the plugin by that relative path. The installation of claude-session-pool::CON-002/AC-02 is two commands, each run once: `claude plugin marketplace add <absolute path of the repository>`, then `claude plugin install cc-session-pool@cc-session-pool`. It is removed with `claude plugin uninstall cc-session-pool@cc-session-pool` and `claude plugin marketplace remove cc-session-pool`.

Installed this way the plugin is used in place, so a change in the repository reaches every session started after it. With this installation the start-up command of the same repository loads no plugin of its own (claude-session-pool::CON-002/AC-04).

The programs that the plugin's server entry and hook declarations run lie in the repository, outside the plugin's directory, and the server needs the packages installed in the repository. The plugin therefore works only where Claude Code uses it in place: loaded with `--plugin-dir` from the repository, or installed from the marketplace added from the repository's path on this Mac. A copy of the plugin's directory alone does not work.

## Out of Scope

- **Ticket state.** The server does not know whether a ticket's pull request is merged, its worktree removed or its test processes stopped; checking these before a slot is cleared or closed stays with the dispatcher session.
- **Ending any process other than a slot's session.** Leftover processes that a worker session's scripts started are not found or ended.
- **Sending work to a slot.** Ticket briefs and answers go through cross-session messages, which the dispatcher session already uses.
- **Background sessions.** Worker sessions are interactive sessions in Terminal windows; `claude --bg` sessions are not opened or adopted.
- **Terminals other than Terminal.** The things that work elsewhere are a `compact_self` call the mod answers (claude-session-pool::US-008/AC-08) and `context_usage` (claude-session-pool::US-010).
- **Resetting or compacting a worker session through the mod.** `clear` and `compact` on a slot deliver typed commands, as before.
- **Windows.** Not supported; nothing in this plugin has been run there.
- **Changing the owner's permission settings.** No auto-mode rule is added or proposed by the server.
- **A pool that spans several directories.**
- **Compacting another session with `compact_self`.** The tool has no argument that names a session; a dispatcher session compacts a slot with `compact`.
- **The context size of another session.** `context_usage` has no argument that names a session, and `status` does not report the context size of a slot.
- **The context size where the mod does not run.** The server offers no `context_usage` and does not work the size out from a transcript.
- **`/context`'s breakdown by category.** `context_usage` gives the three figures of claude-session-pool::US-010/AC-02 only.
- **Choosing what the model is told after a self-compaction.** It is always the sentence of claude-session-pool::US-008/AC-05, or that of claude-session-pool::US-008/AC-11 when the compaction did not complete; what the session does next is its own decision.
- **Installing the plugin.** The owner installs and removes it.
- **Installing the plugin from anywhere but the repository on this Mac.** A marketplace on a git host, or any other source from which Claude Code copies the plugin's directory, is not supported.
- **Confirming a slot's compaction through the hooks.** `compact` on a slot reads the worker session's transcript, as before.
- **Cleaning up wake requests.** A wake request whose compaction never comes is a small file that stays; nothing deletes it.
- **Running `claude` subcommands through the start-up command.** The command adds its arguments to whatever it is given, as for a session start, and a subcommand such as `agents` or `mcp` rejects them. Subcommands are run with `claude` itself.
- **Names of sessions other than the dispatcher session.** A worker session the server opens is named after its slot; a session the owner starts or adopts keeps whatever name Claude Code or the owner gave it.
