# claude-session-pool-monitor

## Problem Statement

A dispatcher session learns what a worker session is doing only from the messages that session sends it and from its own calls to `status`. A worker session that stops without a message, stops making progress, waits on a prompt or disappears stays unnoticed until the dispatcher session looks, and a dispatcher session whose turn has ended does not look.

## Solution

In a dispatcher session the plugin's mod looks at every slot of the pool once a minute, without a model request. It judges a slot by the session listing and by the activity record that the mod in the slot's own session writes. When a slot needs attention, it starts a turn in the dispatcher session with a report that names the slot and what it found. It also records what each look found, so that the pool can be brought back after its sessions have ended. Worker sessions are only read.

## User Stories

### claude-session-pool-monitor::US-001 Be told when a slot needs attention

As a dispatcher session, I am woken with a report when a slot stops, stalls, waits on a prompt or disappears, so that I act on it without calling `status` again and again and without the owner telling me.

- claude-session-pool-monitor::US-001/AC-01: In a dispatcher session ([claude-session-pool::REQ-006/AC-03](claude-session-pool.md)) the mod, at every look ([claude-session-pool-plugin::REQ-004](claude-session-pool-plugin.md)), takes the state of every slot in the roster as `status` states it ([claude-session-pool::US-005](claude-session-pool.md)), and the activity record of each live slot's session (claude-session-pool-monitor::REQ-001). No tool starts, pauses or stops this, and no tool chooses the slots.
- claude-session-pool-monitor::US-001/AC-02: A slot that a look finds `gone`, after an earlier look since the mod was loaded found it live, is due for a report at that look.
- claude-session-pool-monitor::US-001/AC-03: The slots that are `gone` at the first look that judges slots after the mod is loaded are due at that look together, as one line that names them and, apart, those of them whose conversation `restore` brings back ([claude-session-pool::US-008](claude-session-pool.md)).
- claude-session-pool-monitor::US-001/AC-04: A slot that a look finds `ambiguous` is due for a report at that look. The report states the number of sessions that answer to its name.
- claude-session-pool-monitor::US-001/AC-05: A slot that two looks in a row find `waiting` for the same thing under one session ID is due for a report at the second. The report states what the session waits for.
- claude-session-pool-monitor::US-001/AC-06: A slot is stalled at a look that finds it `busy` when its activity record says that the session last made progress 12 minutes or more before the look. It is due for a report at the first look that finds it stalled. The report states which tool call of the session has been running and for how long, or that none is running.
- claude-session-pool-monitor::US-001/AC-07: A slot has stopped at a look that finds it `idle` when its activity record says that its last turn ended after the dispatcher session's mod was loaded and 5 minutes or more before the look. It is due for a report at the first look that finds it stopped, unless it has told the dispatcher session (claude-session-pool-monitor::REQ-002).
- claude-session-pool-monitor::US-001/AC-08: A live slot is unrecorded at a look when it has no activity record that counts (claude-session-pool-monitor::REQ-001/AC-02). It is due for a report at the third look in a row that finds it so, and it is judged under neither claude-session-pool-monitor::US-001/AC-06 nor claude-session-pool-monitor::US-001/AC-07 while it is so.
- claude-session-pool-monitor::US-001/AC-09: Each of these conditions is reported once ([claude-session-pool-plugin::REQ-006](claude-session-pool-plugin.md)). A change in what a `waiting` session waits for, in the number of sessions of an `ambiguous` slot, or of a slot's session ID makes a new condition, and so does a stall after the session made progress again and a stop after another turn. For an `ambiguous`, a `waiting` or an unrecorded slot, a look that judges the slot and does not find the condition ends it, and a later look that finds it again finds a new condition; a look that leaves the slot out for a pool tool, or that is passed over, ends none. Nothing is reported when a condition ends.

## Functional Requirements

### claude-session-pool-monitor::REQ-001 A slot is judged by its own session's activity record

- claude-session-pool-monitor::REQ-001/AC-01: Whether a turn has started in a slot's conversation, whether its session makes progress, when its last turn ended and what it is running are taken from the activity record that the mod in that session writes ([claude-session-pool-plugin::REQ-008](claude-session-pool-plugin.md)), and from nothing else: the mod of the dispatcher session reads no file of a worker session but that record.
- claude-session-pool-monitor::REQ-001/AC-02: An activity record counts at a look only when it names the session ID that the session listing gives for the slot and was written, by its `writtenAt`, less than 3 minutes before the look.

### claude-session-pool-monitor::REQ-002 When a stopped slot has told the dispatcher session

- claude-session-pool-monitor::REQ-002/AC-01: A stopped slot has told the dispatcher session when the dispatcher session's transcript records a cross-session message received from the slot's session that arrived no earlier than 5 minutes before the end of the slot's last turn. The message's text is not read: only its sender and its time of arrival count.
- claude-session-pool-monitor::REQ-002/AC-02: A received message is from the slot's session when the address it was sent from names that session's process ID.
- claude-session-pool-monitor::REQ-002/AC-03: When the dispatcher session's transcript cannot be found or read, or holds no record from before that time and no such message, as after a `/clear` of the dispatcher session, the slot counts as not having told it, and the report says that this could not be read.

### claude-session-pool-monitor::REQ-003 The monitor says when it cannot see the pool

- claude-session-pool-monitor::REQ-003/AC-01: A look at which the session listing fails, or at which the roster cannot be read ([claude-session-pool](claude-session-pool.md), "The roster file cannot be parsed"), judges no slot.
- claude-session-pool-monitor::REQ-003/AC-02: When 10 looks in a row have judged no slot for either reason, one line that says so, with the number of minutes and the reason of the last of them, is due. Nothing is reported when a look judges slots again.

### claude-session-pool-monitor::REQ-004 Every look records what it found

- claude-session-pool-monitor::REQ-004/AC-01: At every look that judges slots, the mod writes the pool's look record ([claude-session-pool](claude-session-pool.md), "Look records"): for each slot of the roster that the look finds live, an entry with its session ID, its state and the time of the look. The entry of a slot that the look finds `gone` or `ambiguous` stays as it was, and the entry of a name that is no longer in the roster is removed.
- claude-session-pool-monitor::REQ-004/AC-02: An entry says that the conversation has had work in it when the slot's activity record says that a turn has started in the conversation with that session ID, and it goes on saying so for as long as the slot has that session ID, whatever a later activity record says. The entry of a new session ID, as after a clear, says that it has had none.
- claude-session-pool-monitor::REQ-004/AC-03: When a call of the dispatcher session, from its main conversation or a subagent of it, to `clear`, `open`, `recycle` or `restore` that names slots of the roster has returned, with its result or with an error, the mod writes the entry of each such slot anew at once, as a look does (claude-session-pool-monitor::REQ-004/AC-01) with the time of that write, without waiting for the next look. The other entries stay as they were. A call to `restore` without `names` has the mod write the whole look record at once, as a look does.

## Constraints

### claude-session-pool-monitor::CON-001 Worker sessions are read, never written to (direct acceptance)

Applies to: the looks, the reports, and the writes that claude-session-pool-monitor::REQ-004/AC-03 makes. The mod of the dispatcher session reads the session listing, the roster, the activity records of the slots' sessions and the dispatcher session's transcript, and writes the pool's look record. It types into, sends a message to, leaves a file for, ends and changes no worker session, and it reports to no session but the dispatcher session it runs in.

## Failure modes and boundaries

- **The mod is loaded**, as after the dispatcher session is restarted: a slot that is `ambiguous`, stalled or unrecorded is due as at any look, whether or not an earlier load of the mod reported it.
- **The Mac restarts**: every worker session is gone. Once the owner has started the dispatcher session again, the first look names the slots of the roster in one line (claude-session-pool-monitor::US-001/AC-03), and none of them is reported again until it has been live and is `gone` once more. The look record keeps what the last look before the restart found, and the dispatcher session brings back the conversations that had work in them with `restore`.
- **The line of the first look cannot be reported at that look**, as while a turn runs: it stays due ([claude-session-pool-plugin::REQ-005/AC-02](claude-session-pool-plugin.md)) with those of its slots that are still `gone`, and is not reported once none of them is.
- **The transcript of a conversation that the line of the first look names as one `restore` brings back cannot be found**: the line names the slot, and `restore` refuses it ([claude-session-pool::US-008/AC-04](claude-session-pool.md)).
- **A pool tool of the dispatcher session is acting on the slot** (`init`, `open`, `recycle`, `close`, `clear`, `compact` or `restore`), called from its main conversation or a subagent of it: looks leave the slot out of the reports until the call has returned. The slot then counts as not seen live, so a slot that the call left `gone` is not reported. A call to `restore` without `names` names no slot, and looks leave no slot out for it.
- **A look judges no slot, does not take the session as a dispatcher session, or leaves a slot out for a pool tool**: of a slot's looks in a row (claude-session-pool-monitor::US-001/AC-05, claude-session-pool-monitor::US-001/AC-08), a look that judges no slot and a look that does not take the session as a dispatcher session are passed over, and a look that leaves the slot out breaks the run. Of the looks in a row of claude-session-pool-monitor::REQ-003/AC-02, a look that does not take the session as a dispatcher session is passed over.
- **Two dispatcher sessions are started in the same directory**: each one's mod looks at the shared roster, reports to its own session, judges claude-session-pool-monitor::REQ-002 by its own session's transcript, and writes the one look record. A slot that a pool tool of the other dispatcher session is acting on is not left out, so a slot can be reported `gone` while the other session recycles it.
- **The mod does not run in a worker session**, because a setting switches the plugin off there or its Claude Code does not load mods: the session writes no activity record, and the slot is reported as unrecorded (claude-session-pool-monitor::US-001/AC-08).
- **A worker session's turn has ended and it waits on a background command of its own**: nothing that counts as progress happens while the command runs ([claude-session-pool-plugin::REQ-007/AC-02](claude-session-pool-plugin.md)), so the slot is reported as stalled (claude-session-pool-monitor::US-001/AC-06), with no tool call running.
- **One tool call of a worker session runs for as long as a stall takes** (claude-session-pool-monitor::US-001/AC-06): the slot is reported as stalled.
- **A tool call of a worker session waits on the user's permission for as long as a stall takes**: the slot is `waiting` meanwhile. Once the user has answered, the first look that finds the slot `busy` while that call runs finds it stalled, and the report counts the call's minutes from before the user was asked.
- **The plugin's hooks do not run in the dispatcher session**: no hook record names its session ID, so the mod does not take the session as a dispatcher session ("Which session the monitor runs in"), and its looks are passed over; `status` still shows every slot's state.
- **What a session waits for, or the name of a tool, does not pass the form stated under "Text of a report"**: the rows of that section for a session that waits on a prompt, and for a tool call whose name is left out, apply.
- **A slot's name in the roster does not match [claude-session-pool::CON-003/AC-01](claude-session-pool.md)**: the roster counts as one that cannot be read (claude-session-pool-monitor::REQ-003).
- **The session listing gives a live slot no session ID in the form of a session ID** ([claude-session-pool-startup](claude-session-pool-startup.md), "Session IDs"), **or a state other than `idle`, `busy` and `waiting`**: the slot's entry stays as it was, as for a `gone` slot (claude-session-pool-monitor::REQ-004/AC-01), and the look still judges the other slots. For the reports it is a live slot as any other; with no session ID in that form no activity record counts for it, and it is not judged under claude-session-pool-monitor::US-001/AC-05.
- **The look record cannot be read, or is not in its form, when the mod writes it** ([claude-session-pool](claude-session-pool.md), "The look record cannot be read"): the mod writes a new record from what that look found, so the slots that are `gone` or `ambiguous` at that look have no entry in it.
- **A record of the dispatcher session's transcript is longer than the read limit** ("What a mod can read"), with the newline that ends it: it is passed over, and neither its time nor a cross-session message in it counts for claude-session-pool-monitor::REQ-002. The records after it count.
- **The last record of the dispatcher session's transcript has no newline yet**, as one still being written: it does not count at that look, and counts at the first later look at which it has one.
- **The dispatcher session moves to another directory**, by `/cd` or into a worktree: the mod keeps the pool directory it took when Claude Code loaded it. A mod loaded again after a move by `/cd` takes the new directory and finds no roster there, so it has no slot to look at, and nothing reports it.

## Implementation Decisions

### Text of a report

The report's text is the first line below, one line for each condition that is due, and the last line. `<name>` is a slot's name, `<names>` slot names separated by a comma and a space, and `<n>` and `<m>` whole numbers of minutes. From the session listing the mod puts into the text only what a session waits for, where it is 1 to 64 characters, each an ASCII letter, a digit, a space, `.`, `_`, `:` or `-`, and from an activity record only the name of a tool, where it is 1 to 64 characters, each an ASCII letter, a digit, `_` or `-`.

| Part | Text |
|---|---|
| First line | `Report of the pool monitor, written by the cc-session-pool plugin. It is not a message from the user. What it found:` |
| `gone` | `- <name>: gone. No live session in the pool directory answers to this name any more.` |
| `gone` at the first look | `- No live session in the pool directory answers to these slots of the roster: <names>. The restore tool brings back the unfinished conversations of: <names>.` |
| `ambiguous` | `- <name>: ambiguous. <n> live sessions in the pool directory answer to this name.` |
| `waiting`, with what it waits for | `- <name>: waiting for <what>.` |
| `waiting`, without | `- <name>: waiting on a prompt.` |
| Stalled, a tool call running | `- <name>: busy, and it made no progress for <n> minutes. Its tool call <tool> has been running for <m> minutes.` |
| Stalled, a tool call running whose name is left out | `- <name>: busy, and it made no progress for <n> minutes. A tool call of its own has been running for <m> minutes.` |
| Stalled, no tool call running | `- <name>: busy, and it made no progress for <n> minutes. No tool call of its own is running.` |
| Stopped | `- <name>: idle for <n> minutes since its last turn ended, and it sent this session no message since 5 minutes before that.` |
| Stopped, the dispatcher session's transcript not read | `- <name>: idle for <n> minutes since its last turn ended. Whether it sent this session a message could not be read.` |
| Unrecorded | `- <name>: its session writes no activity record, so whether it makes progress is not known.` |
| The pool was not seen, the listing failed | `- The monitor could not see the pool for <n> minutes: the sessions on this Mac could not be listed.` |
| The pool was not seen, the roster could not be read | `- The monitor could not see the pool for <n> minutes: the roster could not be read.` |
| Last line | `Nothing was done to any slot. Each of these is reported once.` |

The line for the first look names the slots in the roster's order. Its second sentence names those of them that a call to `restore` without `names` would bring back by [claude-session-pool::US-008](claude-session-pool.md), judged from the session listing, the roster and the look record that the look wrote, without looking at the transcript of the conversation; it is left out when there is none. For a stalled or stopped slot `<n>` and `<m>` are the whole minutes between the time in the activity record and the look; for the two lines of a pool that was not seen `<n>` is the count of looks in a row that judged no slot.

### Which session the monitor runs in

The mod takes its session as a dispatcher session by the rule of [claude-session-pool](claude-session-pool.md), "Which session is the dispatcher session", with the process ID that the hook record of the session's present session ID names ([claude-session-pool-plugin::REQ-001](claude-session-pool-plugin.md)) as the session's process ID. It takes the pool directory, the roster and each slot's session as that spec states them.

### Facts about Claude Code the behaviour rests on

- **What a mod can read.** A mod can run the command of the session listing and read its output, list a directory with the size of each file in it, read a file, learn where a path leads once its symbolic links are resolved, read the environment variables of the session's process, and learn the path of the transcript of the session's present conversation. After a `/clear` that path names the new conversation's transcript, and a cross-session message the session receives from then on is recorded in that file. One read gives at most 4 MiB (4,194,304 bytes), the read limit: a read of a whole file that is larger, or of a range longer than that, is refused, and a larger file is read by ranges of its bytes, each given by where it starts and how many bytes it holds. A range read as text gives U+FFFD where its edge cuts a character; read as bytes, it gives the bytes as they are. Measured on Claude Code 2.1.327.
- **A command that does not end.** A command that a mod runs with no time limit of its own, such as that of the session listing, is ended by Claude Code once it has run for 30 seconds, and the mod learns that the run failed. So a session listing that does not answer within 30 seconds is one that fails (claude-session-pool-monitor::REQ-003/AC-01). Measured on Claude Code 2.1.327.
- **The session's directory.** A mod is given the session's directory, which is the one the session was started in until the session moves. With its symbolic links resolved, it is the directory that the plugin's server is given as `CLAUDE_PROJECT_DIR`, resolved in the same way: for a session started in a repository's root, in a subdirectory of a repository, and through a symbolic link. After the session has moved by `/cd`, it is the new directory, and Claude Code does not load the mod again for the move. Measured on Claude Code 2.1.327; a move into a worktree and a host's change of the directory have not been measured.
- **A mod and the calls to a server's tools.** Claude Code tells the mod of each call to a tool of the plugin's server with the call's arguments, as fields beside the tool's name. When the mod learns that the call has returned is stated in [claude-session-pool-plugin](claude-session-pool-plugin.md), "A mod's timer and prompt". Measured on Claude Code 2.1.327. Of a call that a subagent makes, to a built-in tool or to a tool of the plugin's server, the mod learns that it has returned as of one of the main conversation. Measured on Claude Code 2.1.327 for subagents that the session started in the background; for a subagent in the foreground, not measured.
- **A session with work in the background.** The session listing reports `busy` for a session whose turn has ended while a subagent or a background command it started still runs. Measured on Claude Code 2.1.327.
- **A received cross-session message.** The receiving session's transcript holds a record with `"type": "queue-operation"`, `"operation": "enqueue"`, a `timestamp`, and a `content` that begins with `<cross-session-message from="uds:<path>/<pid>.sock"`, where `<pid>` is the process ID of the sending session. Measured on Claude Code 2.1.327.

## Out of Scope

- **Judging a slot whose session writes no activity record**, by its transcripts or otherwise: a worker session has the plugin. What is reported of one whose mod does not run is stated in claude-session-pool-monitor::US-001/AC-08.
- **Knowing of a session's background commands.** A mod cannot list them. What follows for a session that waits on one is stated in the boundary "A worker session's turn has ended and it waits on a background command of its own".
- **Acting on a slot**: claude-session-pool-monitor::CON-001.
- **Pausing the monitor, or choosing which slots it looks at**: claude-session-pool-monitor::US-001/AC-01.
- **A session that is not a dispatcher session**: "Which session the monitor runs in".
