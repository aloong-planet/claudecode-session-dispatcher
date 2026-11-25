# claude-session-pool-monitor

## Problem Statement

A dispatcher session learns what a worker session is doing only from the messages that session sends it and from its own calls to `status`. A worker session that stops without a message, stops making progress, waits on a prompt or disappears stays unnoticed until the dispatcher session looks, and a dispatcher session whose turn has ended does not look.

## Solution

In a dispatcher session the plugin's mod looks at every slot of the pool once a minute, without a model request. It takes each slot's state from the session listing and, from the activity record that the mod in the slot's own session writes, whether the slot's conversation has had work in it. It records what each look found, so that `status` can state what a slot whose session has ended last was. Worker sessions are only read.

## User Stories

### claude-session-pool-monitor::US-001 Be told when a slot needs attention

As a dispatcher session, I am woken with a report when a slot stops, stalls, waits on a prompt or disappears, so that I act on it without calling `status` again and again and without the owner telling me.

> Pending: the mod starts a turn with a report when a look finds that a slot needs attention. Until it does, a look takes the slots' states (claude-session-pool-monitor::US-001/AC-01) and writes the look record (claude-session-pool-monitor::REQ-004), and reports nothing.

- claude-session-pool-monitor::US-001/AC-01: In a dispatcher session ([claude-session-pool::REQ-006/AC-03](claude-session-pool.md)) the mod, at every look ([claude-session-pool-plugin::REQ-004](claude-session-pool-plugin.md)), takes the state of every slot in the roster as `status` states it ([claude-session-pool::US-005](claude-session-pool.md)), and the activity record of each live slot's session (claude-session-pool-monitor::REQ-001). No tool starts, pauses or stops this, and no tool chooses the slots.

## Functional Requirements

### claude-session-pool-monitor::REQ-001 A slot is judged by its own session's activity record

- claude-session-pool-monitor::REQ-001/AC-01: Whether a turn has started in a slot's conversation is taken from the activity record that the mod in the slot's session writes ([claude-session-pool-plugin::REQ-008](claude-session-pool-plugin.md)), and from nothing else: the mod of the dispatcher session reads no file of a worker session but that record.
- claude-session-pool-monitor::REQ-001/AC-02: An activity record counts at a look only when it names the session ID that the session listing gives for the slot and was written, by its `writtenAt`, less than 3 minutes before the look.

### claude-session-pool-monitor::REQ-003 The monitor says when it cannot see the pool

- claude-session-pool-monitor::REQ-003/AC-01: A look at which the session listing fails, or at which the roster cannot be read ([claude-session-pool](claude-session-pool.md), "The roster file cannot be parsed"), judges no slot.

### claude-session-pool-monitor::REQ-004 Every look records what it found

- claude-session-pool-monitor::REQ-004/AC-01: At every look that judges slots, the mod writes the pool's look record ([claude-session-pool](claude-session-pool.md), "Look records"): for each slot of the roster that the look finds live, an entry with its session ID, its state and the time of the look. The entry of a slot that the look finds `gone` or `ambiguous` stays as it was, and the entry of a name that is no longer in the roster is removed.
- claude-session-pool-monitor::REQ-004/AC-02: An entry says that the conversation has had work in it when the slot's activity record says that a turn has started in the conversation with that session ID, and it goes on saying so for as long as the slot has that session ID, whatever a later activity record says. The entry of a new session ID, as after a clear, says that it has had none.
- claude-session-pool-monitor::REQ-004/AC-03: When a call of the dispatcher session to `clear`, `open`, `recycle` or `restore` that names a slot of the roster has returned, with its result or with an error, the mod writes that slot's entry anew at once, as a look does (claude-session-pool-monitor::REQ-004/AC-01) with the time of that write, without waiting for the next look. The other entries stay as they were. When a call to `restore` without `names` has returned, the mod writes the look record at once as a look does (claude-session-pool-monitor::REQ-004/AC-01), without waiting for the next look.

## Constraints

### claude-session-pool-monitor::CON-001 Worker sessions are read, never written to (direct acceptance)

Applies to: the looks, and the writes that claude-session-pool-monitor::REQ-004/AC-03 makes. The mod of the dispatcher session reads the session listing, the roster and the activity records of the slots' sessions, and writes the pool's look record. It types into, sends a message to, leaves a file for, ends and changes no worker session.

## Failure modes and boundaries

- **The plugin's hooks do not run in the dispatcher session**: no hook record names its session ID, so the mod does not take the session as a dispatcher session ("Which session the monitor runs in") and judges no slot; `status` still shows every slot's state.
- **A slot's name in the roster does not match [claude-session-pool::CON-003/AC-01](claude-session-pool.md)**: the roster counts as one that cannot be read (claude-session-pool-monitor::REQ-003).
- **The session listing gives a live slot no session ID in the form of a session ID** ([claude-session-pool-startup](claude-session-pool-startup.md), "Session IDs"), **or a state other than `idle`, `busy` and `waiting`**: the slot's entry stays as it was, as for a `gone` slot (claude-session-pool-monitor::REQ-004/AC-01), and the look still judges the other slots.
- **The look record cannot be read, or is not in its form, when the mod writes it** ([claude-session-pool](claude-session-pool.md), "The look record cannot be read"): the mod writes a new record from what that look found, so the slots that are `gone` or `ambiguous` at that look have no entry in it.

## Implementation Decisions

### Which session the monitor runs in

The mod takes its session as a dispatcher session by the rule of [claude-session-pool](claude-session-pool.md), "Which session is the dispatcher session", with the process ID that the hook record of the session's present session ID names ([claude-session-pool-plugin::REQ-001](claude-session-pool-plugin.md)) as the session's process ID. It takes the pool directory, the roster and each slot's session as that spec states them.

### Facts about Claude Code the behaviour rests on

- **What a mod can read.** A mod can run the command of the session listing and read its output, list a directory with the size of each file in it, read a file, learn where a path leads once its symbolic links are resolved, and read the environment variables of the session's process. Measured on Claude Code 2.1.327.
- **The session's directory.** A mod is given the directory the session was started in. With its symbolic links resolved, it is the directory that the plugin's server is given as `CLAUDE_PROJECT_DIR`, resolved in the same way: for a session started in a repository's root, in a subdirectory of a repository, and through a symbolic link. Measured on Claude Code 2.1.327; a session moved by `/cd` has not been measured.
- **A mod and the calls to a server's tools.** Claude Code tells the mod of each call to a tool of the plugin's server with the call's arguments, as fields beside the tool's name. When the mod learns that the call has returned is stated in [claude-session-pool-plugin](claude-session-pool-plugin.md), "A mod's timer and prompt". Measured on Claude Code 2.1.327.

## Out of Scope

- **Acting on a slot**: claude-session-pool-monitor::CON-001.
- **Pausing the monitor, or choosing which slots it looks at**: claude-session-pool-monitor::US-001/AC-01.
- **A session that is not a dispatcher session**: "Which session the monitor runs in".
