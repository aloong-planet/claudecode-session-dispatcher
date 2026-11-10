# claude-session-pool

> Related: [ADR-0001](../adr/0001-interactive-terminal-worker-sessions.md)

## Problem Statement

A dispatcher session hands tickets to worker sessions and receives their reports through cross-session messages. It cannot create a worker session, and neither it nor a worker session can run `/clear` or `/compact`. The owner therefore opens every worker session by hand, types `/clear` into it after each ticket and `/compact` before each pull request, and tells the dispatcher session when that is done. Whenever the owner is away, the run stops.

## Solution

An MCP server attached to the dispatcher session alone. Through its tools the dispatcher session opens worker sessions in Terminal windows, registers ones the owner opened, resets or compacts a worker session's conversation by typing the command into its window, reads the real state of every slot, and closes or replaces a worker session. None of these steps needs the owner.

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

- claude-session-pool::US-006/AC-01: `close` on an idle slot ends its session's process, waits for the process to exit, and removes the slot from the roster. When the server opened the slot's Terminal window, `close` also closes that window.
- claude-session-pool::US-006/AC-02: `close` on a slot the server adopted ends the session and leaves the owner's Terminal window open.
- claude-session-pool::US-006/AC-03: `close` on a slot that is `busy` or `waiting` refuses and states the slot's state, unless the `force` argument is true; with `force` true it proceeds as for an idle slot.
- claude-session-pool::US-006/AC-04: `close` on a `gone` slot removes it from the roster and succeeds.
- claude-session-pool::US-006/AC-05: When the session's process has not exited 15 seconds after `close` asked it to end, `close` returns an error, keeps the slot in the roster, and closes no window. This holds with `force` true as well.
- claude-session-pool::US-006/AC-06: `recycle` closes the slot as `close` does, with the same `force` rule, and then opens a new worker session under the same name as `open` does; it takes the `model` and `permissionMode` arguments of `open`, with the same defaults. The slot then holds a new process and a new conversation.
- claude-session-pool::US-006/AC-07: When the close step of `recycle` refuses or fails, nothing is opened. When the close step succeeds and the open step fails, the slot stays in the roster, is `gone`, and the error says so.

## Functional Requirements

### claude-session-pool::REQ-001 Only slots, and never the dispatcher session

- claude-session-pool::REQ-001/AC-01: `clear`, `compact`, `close` and `recycle` refuse a name that is not a slot in the roster, and act on no session.
- claude-session-pool::REQ-001/AC-02: No tool types into, ends or registers the dispatcher session.

### claude-session-pool::REQ-002 Delivering a typed command

- claude-session-pool::REQ-002/AC-01: A typed command is typed only while the slot's session is idle. When it is not idle, the tool waits up to 60 seconds for it to become idle; if it is still not idle, the tool refuses, types nothing, and states the slot's state and what it is waiting for.
- claude-session-pool::REQ-002/AC-02: Text that is sitting in the session's input box when the command is typed is discarded. It is not submitted as a message, and the command still runs.
- claude-session-pool::REQ-002/AC-03: The command is typed into the Terminal tab that hosts the slot's session, without bringing that window to the front. When no such tab is found, or the slot is `gone` or `ambiguous`, the tool refuses and types nothing.

### claude-session-pool::REQ-003 One pool per directory (direct acceptance)

The pool directory is the directory the dispatcher session was started in; every session the server opens starts in that directory, and two dispatcher sessions started in different directories have separate rosters.

### claude-session-pool::REQ-004 The roster outlives the server process (direct acceptance)

A slot added by one server process is a slot for the next server process started in the same directory, including after the dispatcher session is restarted.

### claude-session-pool::REQ-005 Refusals and failures are reported, not hidden (direct acceptance)

Every refusal and failure is returned as a tool error whose text states the reason and the state the server observed; no tool reports success for a step it did not confirm.

## Constraints

### claude-session-pool::CON-001 Terminal on macOS only (direct acceptance)

Applies to: every tool; worker sessions run in windows of the macOS Terminal application (ADR-0001), and a session in any other terminal, or a background session, cannot be opened, adopted or acted on.

### claude-session-pool::CON-002 Attached to the dispatcher session only (direct acceptance)

Applies to: installation and start-up; the repository provides one command that starts a Claude Code session with this server attached to that session, passing its arguments on to `claude`. Attaching it changes no user-level or project-level MCP configuration, so worker sessions do not see the tools. The command loads the tool definitions up front, so the dispatcher session calls a tool without first searching for it.

### claude-session-pool::CON-003 Arguments that reach a command line are validated

Applies to: `init`, `open`, `adopt`, `clear`, `compact`, `close`, `recycle`.

- claude-session-pool::CON-003/AC-01: A slot name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; any other name is refused before anything is run.
- claude-session-pool::CON-003/AC-02: A `model` argument must match `^[A-Za-z0-9._\[\]-]{1,64}$`; any other value is refused before anything is run.
- claude-session-pool::CON-003/AC-03: A `permissionMode` argument must be one of `auto`, `acceptEdits`, `default`, `plan` and `dontAsk`. Any other value, `bypassPermissions` included, is refused before anything is run.
- claude-session-pool::CON-003/AC-04: A pool directory whose path contains spaces or quote characters is handled as that exact path.

### claude-session-pool::CON-004 Runtime (direct acceptance)

Applies to: the server process; it runs on the `node` found on the dispatcher session's `PATH`, which must be Node.js 22.18 or later, with no build step.

## Failure modes and boundaries

Slot states and how a slot moves between them:

| From | To | By |
|---|---|---|
| not a slot | live (`idle`, `busy` or `waiting`) | `open`, `init`, `adopt` |
| live | not a slot | `close` |
| live | `gone` | the owner closes the window; the session crashes; the Mac restarts; the open step of `recycle` fails |
| `gone` | live | `open` or `recycle` under the same name; the owner starts a session under that name in the pool directory |
| `gone` | not a slot | `close` |
| live | `ambiguous` | the owner starts a second session under the same name in the pool directory |
| `ambiguous` | live | one of the two sessions ends |

Boundaries and failures:

- **A message reaches a slot between the idle check and the typing.** The session starts a turn, and the interrupt that discards the input box (claude-session-pool::REQ-002/AC-02) ends that turn. The server does not detect this. The tool's result still follows its own confirmation rule.
- **`clear` or `compact` on a slot that is `gone` or `ambiguous`**: refused under claude-session-pool::REQ-002/AC-03.
- **`close` or `recycle` on an `ambiguous` slot**: refused, with the number of sessions that answer to the name; `force` does not change this.
- **`open` on a name that is a `gone` slot**: allowed; the slot becomes live again. On a live slot it is refused under claude-session-pool::US-001/AC-05.
- **Terminal cannot be scripted** (macOS refuses the automation request, or Terminal reports an error): the tool returns that error text; `open` adds no slot.
- **The roster file cannot be parsed, or carries a version this server does not know**: every tool refuses and names the file; the file is not rewritten.
- **Two calls arrive at the same time**: typing into Terminal and updating the roster happen one call at a time, so two calls never interleave keystrokes or lose a roster update.
- **Two dispatcher sessions are started in the same directory**: they share that directory's roster. Every tool call reads the roster file afresh, so each sees the other's changes.
- **Text read from a Terminal window** (claude-session-pool::US-001/AC-06) is returned inside the error as quoted text; the server takes no action based on it.
- **The dispatcher session ends while a `compact` call is waiting**: the wait is lost and no result is delivered; the compaction itself continues in the worker session, and a later `status` shows the slot's state.
- **A session that is asked to end holds unsaved work**: `close` does not check for it; what a worker session must have finished before it is closed is decided by the dispatcher session.

## Implementation Decisions

### Tools

The server is named `claude-session-pool` and offers these tools. Every result is text.

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

### Facts about Claude Code and Terminal the behaviour rests on

- **Session listing.** `claude agents --json` prints one entry per session. The server uses `kind` (`interactive` or `background`), `pid`, `cwd`, `name`, `sessionId`, `status` (`idle`, `busy` or `waiting`) and `waitingFor`. A live session is an entry that has a `pid`.
- **Which session a slot is.** A slot's session is the live `interactive` entry whose `name` equals the slot name and whose `cwd` is the pool directory. Directories are compared after resolving symbolic links.
- **Which session the dispatcher is.** The dispatcher session is the entry whose `pid` is the server's parent process.
- **Which window hosts a session.** The session's process has a controlling terminal device; the hosting tab is the Terminal tab whose `tty` is that device.
- **Opening.** Terminal's `do script` with no target opens a new window and runs a shell command in it. The command changes to the pool directory and replaces the shell with `claude -n <name> --model <model> --permission-mode <mode>`, so that no shell is left in the tab when the session ends.
- **Typing.** Terminal's `do script <text> in <tab>` delivers the text followed by Return to the program in that tab. A typed command is the character U+0003 (Ctrl+C) followed by the command; Claude Code clears its input box on that character and stays running.
- **Confirming a clear.** `/clear` gives the session a new `sessionId` and leaves its `pid` and `name` unchanged.
- **Confirming a compaction.** A session's transcript is the file `<sessionId>.jsonl` in a subdirectory of `~/.claude/projects/`. A finished compaction appends a record with `"type": "system"`, `"subtype": "compact_boundary"` and a `timestamp`. Claude Code does not document this file as a stable interface; claude-session-pool::US-004/AC-04 covers the case where it cannot be read. A session reports `busy` while it compacts.
- **Ending a session.** The server sends the session's process the termination signal; Claude Code exits on it. The server sends no other signal.
- **Closing a window.** Terminal's `close` on a window whose tab runs no process closes it without a confirmation. A closed window can still be listed for a short time with no tabs; the server treats a window with no tabs, or one that is not visible, as closed.

### Roster file

- One file per pool: `~/.claude-session-pool/pools/<key>.json`, where `<key>` is the first 16 hexadecimal digits of the SHA-256 hash of the pool directory's absolute path after resolving symbolic links.
- Content: a JSON object with `version` (the number `1`), `directory` (that absolute path) and `slots`, a list of objects with `name` and `origin`, where `origin` is `"opened"` or `"adopted"`. `recycle` sets `origin` to `"opened"`.
- A missing file means an empty roster. A file whose `version` is not `1`, whose `directory` differs from the pool directory, or that is not valid JSON, is handled as the "cannot be parsed" failure above.
- The file is replaced atomically on every change.

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

### Start-up command

The start-up command of claude-session-pool::CON-002 passes `claude` an MCP configuration that names this server, gives the absolute path of its entry file, and sets `alwaysLoad` to true.

## Out of Scope

- **Ticket state.** The server does not know whether a ticket's pull request is merged, its worktree removed or its test processes stopped; checking these before a slot is cleared or closed stays with the dispatcher session.
- **Ending any process other than a slot's session.** Leftover processes that a worker session's scripts started are not found or ended.
- **Sending work to a slot.** Ticket briefs and answers go through cross-session messages, which the dispatcher session already uses.
- **Background sessions.** Worker sessions are interactive sessions in Terminal windows; `claude --bg` sessions are not opened or adopted.
- **Terminals other than Terminal.**
- **Changing the owner's permission settings.** No auto-mode rule is added or proposed by the server.
- **A pool that spans several directories.**
