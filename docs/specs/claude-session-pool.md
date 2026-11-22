# claude-session-pool

> Related: [ADR-0001](../adr/0001-interactive-terminal-worker-sessions.md)

## Problem Statement

A dispatcher session hands tickets to worker sessions and receives their reports through cross-session messages. It cannot create a worker session, and neither it nor a worker session can run `/clear` or `/compact`. The owner therefore opens every worker session by hand, types `/clear` into it after each ticket and `/compact` before each pull request, and tells the dispatcher session when that is done. Whenever the owner is away, the run stops.

## Solution

A Claude Code plugin whose MCP server offers the dispatcher session nine tools that manage a pool. Through them the dispatcher session opens worker sessions in Terminal windows, registers ones the owner opened, resets a worker session's conversation, compacts one, reads the real state of every slot, closes or replaces a worker session, and takes a slot off the roster. Apart from starting the dispatcher session and installing the plugin, nothing described here needs the owner.

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

- claude-session-pool::US-003/AC-01: `clear` on a slot delivers `/clear` under claude-session-pool::REQ-007 and returns once the slot's session ID has changed. The result states the old and the new session ID, and whether the command was delivered as a clear order or typed. The slot keeps its name, its Terminal window and its process.
- claude-session-pool::US-003/AC-02: When the session ID has not changed 30 seconds after the command was delivered, `clear` returns an error stating that the clear order was written, or the command typed, and not confirmed. It types nothing afterwards, and it removes a clear order that still stands.

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

## Functional Requirements

### claude-session-pool::REQ-001 Only slots, and never the dispatcher session

- claude-session-pool::REQ-001/AC-01: `clear`, `compact`, `close`, `recycle` and `release` refuse a name that is not a slot in the roster, and act on no session.
- claude-session-pool::REQ-001/AC-02: None of the nine tools types into, writes a clear order for, ends or registers the dispatcher session.

### claude-session-pool::REQ-002 Delivering a command to a slot's session

- claude-session-pool::REQ-002/AC-01: A typed command is typed, and a clear order is written, only while the slot's session is idle. When it is not idle, the tool waits up to 60 seconds for it to become idle; if it is still not idle, the tool refuses, types and writes nothing, and states the slot's state and what it is waiting for.
- claude-session-pool::REQ-002/AC-02: Text that is sitting in the session's input box when the command is typed is discarded. It is not submitted as a message, and the command still runs.
- claude-session-pool::REQ-002/AC-03: The command is typed into the Terminal tab that hosts the slot's session, without bringing that window to the front. When no such tab is found, or the slot is `gone` or `ambiguous`, the tool refuses and types nothing.

### claude-session-pool::REQ-003 One pool per directory (direct acceptance)

The pool directory is the directory the dispatcher session was started in; every session the server opens starts in that directory, and two dispatcher sessions started in different directories have separate rosters.

### claude-session-pool::REQ-004 The roster outlives the server process (direct acceptance)

A slot added by one server process is a slot for the next server process started in the same directory, including after the dispatcher session is restarted.

### claude-session-pool::REQ-005 Refusals and failures are reported, not hidden

- claude-session-pool::REQ-005/AC-01: Every refusal and failure is returned as a tool error whose text states the reason and the state the server observed; no tool reports success for a step it did not confirm.
- claude-session-pool::REQ-005/AC-02: When a step that cannot be taken back has been done (a window opened, a command typed, a clear order written, a session ended) and what follows fails, the error says that the step was done.
- claude-session-pool::REQ-005/AC-03: A session listing that fails while a tool waits after such a step does not end the wait. The wait goes on to its limit, and an error at the limit includes the listing's error.
- claude-session-pool::REQ-005/AC-04: When the slot's session disappears, or another process comes to answer to the slot's name, while `clear` or `compact` waits, the tool returns at once and states the slot's state.

### claude-session-pool::REQ-006 What the server offers depends on how the session was started

- claude-session-pool::REQ-006/AC-01: To a dispatcher session the server offers `init`, `open`, `adopt`, `status`, `clear`, `compact`, `close`, `recycle` and `release`.
- claude-session-pool::REQ-006/AC-02: To any other attached session the server offers none of these nine tools. A call to one of them is answered with an error and does nothing.
- claude-session-pool::REQ-006/AC-03: A session is a dispatcher session only when the start-up command started it ([claude-session-pool-startup::REQ-001](claude-session-pool-startup.md)). A worker session the server opened, a session started with `claude` directly, and a session started from inside a dispatcher session are not dispatcher sessions.

### claude-session-pool::REQ-007 Delivering `clear` as a clear order or as a typed command

- claude-session-pool::REQ-007/AC-01: When the plugin's hooks run in the slot's session ([claude-session-pool-plugin::REQ-001/AC-02](claude-session-pool-plugin.md)), `clear` writes a clear order for the session's present session ID once the session is idle (claude-session-pool::REQ-002/AC-01), and types nothing. When they do not, `clear` delivers `/clear` as a typed command under claude-session-pool::REQ-002. When the slot is `gone` or `ambiguous`, `clear` refuses and writes nothing.
- claude-session-pool::REQ-007/AC-02: In a session in which the plugin's mod runs, the mod acts on a clear order only while it stands, both its file name and its content name the session's present session ID, and it was written less than 60 seconds ago. It then runs `/clear` once no turn is running in the session, which gives the session a new session ID, to which the order no longer applies. When Claude Code refuses the command, the mod asks again ([claude-session-pool-plugin::REQ-002](claude-session-pool-plugin.md)) as long as the order counts. It acts on no other order.

## Constraints

### claude-session-pool::CON-001 Terminal on macOS only (direct acceptance)

Applies to: the nine tools; worker sessions run in windows of the macOS Terminal application (ADR-0001), and a session in any other terminal, or a background session, cannot be opened, adopted or typed into. A `clear` delivered as a clear order (claude-session-pool::REQ-007/AC-01) types nothing and does not script Terminal.

### claude-session-pool::CON-003 Arguments that reach a command line are validated

Applies to: `init`, `open`, `adopt`, `clear`, `compact`, `close`, `recycle`, `release`.

- claude-session-pool::CON-003/AC-01: A slot name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; any other name is refused before anything is run.
- claude-session-pool::CON-003/AC-02: A `model` argument must match `^[A-Za-z0-9._\[\]-]{1,64}$`; any other value is refused before anything is run.
- claude-session-pool::CON-003/AC-03: A `permissionMode` argument must be one of `auto`, `acceptEdits`, `default`, `plan` and `dontAsk`. Any other value, `bypassPermissions` included, is refused before anything is run.
- claude-session-pool::CON-003/AC-04: A pool directory whose path contains spaces or quote characters is handled as that exact path.

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
- **`close` or `recycle` on an `ambiguous` slot**: refused, with the number of sessions that answer to the name; `force` does not change this.
- **`open` on a name that is a `gone` slot**: allowed; the slot becomes live again. On a live slot it is refused under claude-session-pool::US-001/AC-05. When the new session is not idle within 60 seconds, the slot stays in the roster and the error says so; the roster then records the new session if it is listed, and otherwise no session.
- **Terminal cannot be scripted** (macOS refuses the automation request, or Terminal reports an error): the tool returns that error text, and `open` adds no slot.
- **The roster file cannot be parsed, or carries a version this server does not know**: every tool refuses and names the file; the file is not rewritten.
- **Two calls arrive at the same time**: typing into Terminal, writing a clear order and updating the roster happen one call at a time, so two calls never interleave keystrokes or lose a roster update. Of two `open` calls for one name, one proceeds and the other is refused without opening a window. Two `adopt` calls for one name register the slot once.
- **Two dispatcher sessions are started in the same directory**: they share that directory's roster. Every call reads the roster file afresh, so each sees the other's changes.
- **Text read from a Terminal window** (claude-session-pool::US-001/AC-06) is returned inside the error as quoted text; the server takes no action based on it.
- **The dispatcher session ends while a `compact` call is waiting**: the wait is lost and no result is delivered; the compaction itself continues in the worker session, and a later `status` shows the slot's state.
- **A session that is asked to end holds unsaved work**: `close` does not check for it; what a worker session must have finished before it is closed is decided by the dispatcher session.
- **A turn starts in the worker session between the idle check and the clear order**: the turn is not interrupted, and the mod runs `/clear` when it ends (claude-session-pool::REQ-007/AC-02). When that is more than 30 seconds after the order was written, `clear` has ended and removed the order (claude-session-pool::US-003/AC-02), so no clear follows.
- **The plugin's hooks run in a worker session and its mod does not**, because its Claude Code does not load the mod: nothing acts on the order, and `clear` ends as claude-session-pool::US-003/AC-02 states.
- **A process of the same user writes a clear order** for a session's present session ID, the dispatcher session's included: the mod acts on it as on the server's (claude-session-pool::REQ-007/AC-02), and nothing checks who wrote it (ADR-0001).
- **A hook of another plugin keeps the file-change event that told the mod of a clear order for longer than the mod keeps asking** ([claude-session-pool-plugin::REQ-002](claude-session-pool-plugin.md)): the order is not acted on, and `clear` ends unconfirmed (claude-session-pool::US-003/AC-02).
- **The mod is loaded again**: it is told of no change under the directory of the clear orders until the session starts again, so a `clear` of that session ends unconfirmed (claude-session-pool::US-003/AC-02).
- **The screen is locked**: whether Claude Code tells the mod of a change under the directory of the clear orders, and runs its `/clear`, has not been measured.

## Implementation Decisions

### Tools

The server offers these tools to the sessions that claude-session-pool::REQ-006 states. Every result is text.

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

### Facts about Claude Code and Terminal the behaviour rests on

The processes of the server and the hooks, and the attached session, are described in [claude-session-pool-plugin](claude-session-pool-plugin.md).

- **Session listing.** `claude agents --json` prints one entry per session. The server uses `kind` (`interactive` or `background`), `pid`, `cwd`, `name`, `sessionId`, `status` (`idle`, `busy` or `waiting`) and `waitingFor`. A live session is an entry that has a `pid`.
- **Which session a slot is.** A slot's session is the live `interactive` entry whose `name` equals the slot name and whose `cwd` is the pool directory. Directories are compared after resolving symbolic links.
- **Which session is the dispatcher session.** A server process treats its attached session as a dispatcher session only when the environment variable `CLAUDE_SESSION_POOL_DISPATCHER_PID` equals the process ID of its parent process. A session started from inside a dispatcher session inherits the variable and has another process ID.
- **Which window hosts a session.** The session's process has a controlling terminal device; the hosting tab is the Terminal tab whose `tty` is that device.
- **Opening.** Terminal's `do script` with no target opens a new window and runs a shell command in it. The command changes to the pool directory and replaces the shell with `claude -n <name> --model <model> --permission-mode <mode>`, so that no shell is left in the tab when the session ends.
- **Typing.** Terminal's `do script <text> in <tab>` delivers the text followed by Return to the program in that tab. A typed command is the character U+0003 (Ctrl+C) followed by the command; an idle Claude Code session clears its input box on that character and stays running. Claude Code takes a long text that arrives in one piece as pasted text: it leaves the text in the input box without submitting it, and a U+0003 in front of it does not empty the box. The two texts the server types, `/clear` and `/compact`, are short enough to be taken as keystrokes.
- **Transcript.** A session's transcript is the file `<sessionId>.jsonl` in a subdirectory of `~/.claude/projects/`, with one JSON object per line. A line that is still being written is not valid JSON and is not counted. Claude Code does not document this file as a stable interface.
- **Confirming a clear.** `/clear` gives the session a new `sessionId` and leaves its `pid` and `name` unchanged.
- **Confirming a compaction.** A finished compaction appends a record with `"type": "system"`, `"subtype": "compact_boundary"` and a `timestamp` to the transcript; the server looks only at what was appended after the command was typed. A session reports `busy` while it compacts.
- **Ending a session.** The server sends the session's process the termination signal; Claude Code exits on it. The server sends no other signal.
- **Closing a window.** Terminal's `close` applies to a window; a tab does not accept it. On a window whose tab runs no process it closes the window without a confirmation. A closed window can still be listed for a short time with no tabs; the server treats a window with no tabs, or one that is not visible, as closed.
- **A mod's file watch and `/clear`.** The result that a mod's `SessionStart` hook returns can name paths, which need not exist yet. Claude Code then tells the mod when a file under them is added, changed or removed, and keeps doing so after a `/clear`, which runs the mod's `SessionStart` hook again with the source `clear`; it does so for every plugin whose hook names paths, whatever the order of the plugins, and tells each plugin's mod of every change. A mod that Claude Code loaded again is told of no change until the session starts again. The mod can ask Claude Code to run `/clear`, which Claude Code runs once the session is idle and rejects while the file-change event that told the mod is still being handled, by the mod's hook or by that of another plugin. Measured on Claude Code 2.1.327.

### Roster file

- One file per pool: `~/.claude-session-pool/pools/<key>.json`, where `<key>` is the first 16 hexadecimal digits of the SHA-256 hash of the pool directory's absolute path after resolving symbolic links.
- Content: a JSON object with `version` (the number `1`), `directory` (that absolute path) and `slots`, a list of objects with `name` and `origin`, where `origin` is `"opened"` or `"adopted"`. An opened slot also has `pid`, the process ID of the session the server opened for it; `pid` is left out when that session was not listed within 60 seconds of its window opening. `open` and `recycle` set `origin` to `"opened"`, and `pid` to the new session's process ID when it is listed.
- The server treats a slot's window as one it opened only when the slot is `"opened"` and the live session's process ID equals `pid`. A slot without `pid` is treated as not opened by the server. That includes a window whose session was not listed within 60 seconds of its opening: when the session appears later, `close` ends it and leaves its window open.
- A missing file means an empty roster. A file whose `version` is not `1`, whose `directory` differs from the pool directory, or that is not valid JSON, is handled as the "cannot be parsed" failure above.
- The file is replaced atomically on every change.

### Clear orders and the mod's part in `clear`

- A clear order is the file `~/.claude-session-pool/clear-orders/<sessionId>.json`. Content: a JSON object with `version` (the number `1`), `sessionId` and `requestedAt`, the time `clear` wrote it, in ISO 8601 form in UTC. `clear` removes it once it has confirmed the clear and when it ends unconfirmed; nothing else removes it, so one left behind applies to no session after 60 seconds or after the session's next `/clear`. How a file that is not in this form is read is stated in [claude-session-pool-plugin](claude-session-pool-plugin.md), under "State files".
- At every start of the session, the start after a `/clear` included, the mod has Claude Code watch the directory of the clear orders. It looks for the order named after the session's present session ID when Claude Code tells it of a change and when a turn ends, and counts the order only when it stands, is in the form stated here, names the session and is less than 60 seconds old.

## Out of Scope

- **Ticket state.** The server does not know whether a ticket's pull request is merged, its worktree removed or its test processes stopped; checking these before a slot is cleared or closed stays with the dispatcher session.
- **Ending any process other than a slot's session.** Leftover processes that a worker session's scripts started are not found or ended.
- **Sending work to a slot.** Ticket briefs and answers go through cross-session messages, which the dispatcher session already uses.
- **Windows.** Not supported; nothing in this plugin has been run there.
- **Changing the owner's permission settings.** No auto-mode rule is added or proposed by the server.
- **A pool that spans several directories.**
