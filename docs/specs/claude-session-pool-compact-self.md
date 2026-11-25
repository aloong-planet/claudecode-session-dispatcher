# claude-session-pool-compact-self

> Related: [ADR-0001](../adr/0001-interactive-terminal-worker-sessions.md), [ADR-0002](../adr/0002-wake-a-self-compacting-session.md)

## Problem Statement

No session can compact its own conversation: a session that should carry on with less context stops and waits for the owner to type `/compact` and then to tell it to go on.

## Solution

Every session that has the plugin's server gets a tool, `compact_self`, with which it compacts its own conversation and is woken afterwards so that it carries on, without anyone typing `/compact` or telling it to go on.

## User Stories

### claude-session-pool-compact-self::US-001 Compact my own conversation and carry on

As a session, I compact my own conversation when I judge it is time and continue afterwards, so that the owner neither types `/compact` into my window nor tells me to go on.

A call to `compact_self` is handled in one of two ways, and claude-session-pool-compact-self::US-001/AC-02 states which. claude-session-pool-compact-self::US-001/AC-04 to claude-session-pool-compact-self::US-001/AC-10 describe a call the mod answers; claude-session-pool-compact-self::US-002 describes a call the server handles.

- claude-session-pool-compact-self::US-001/AC-01: `compact_self` takes no arguments and acts on no session but the attached session. The server offers it to every attached session, the dispatcher session included.
- claude-session-pool-compact-self::US-001/AC-02: In an interactive session in which the plugin's mod runs, the mod answers a call to `compact_self` in the server's place: the server's tool does not run, nothing is typed, and no wake request is left. In every other session the call reaches the server. A call that the mod cannot tie to a conversation, because Claude Code does not give it the session's ID, reaches the server, and so does a call in a session whose start the mod was not told of, which counts as not interactive.
- claude-session-pool-compact-self::US-001/AC-03: When a compaction that `compact_self` asked for has finished and the session is woken, the model is handed the sentence `The compaction this session requested with compact_self has finished. This is not an error. Continue the work that was in progress.` The sentence is always the same; the tool accepts no text to hand over.
- claude-session-pool-compact-self::US-001/AC-04: None of the refusals of claude-session-pool-compact-self::US-002/AC-06 applies to a call the mod answers; in particular the session need not run in a Terminal window. The result states that the conversation is compacted when the current turn ends and that the session is woken after the compaction.
- claude-session-pool-compact-self::US-001/AC-05: When the turn in which the call was made ends with the model's answer, the mod has Claude Code compact the attached session's conversation, with nothing typed. When the compaction has finished, the mod starts a turn in the session, and the model is handed the sentence of claude-session-pool-compact-self::US-001/AC-03; the plugin's hook does not wake the session after this compaction. When the conversation has a wake request, which an earlier call the server handled left (claude-session-pool-compact-self::US-002/AC-04, claude-session-pool-compact-self::US-002/AC-07), the mod starts no turn after the compaction, and the plugin's hook wakes the session instead, as claude-session-pool-compact-self::US-002/AC-05 states, which uses the request up. Either way the session starts one turn, not two.
- claude-session-pool-compact-self::US-001/AC-06: When Claude Code refuses the compaction because a turn is in progress, the mod asks again ([claude-session-pool-plugin::REQ-002](claude-session-pool-plugin.md)). When the last of these is refused for the same reason, the request stands, and the mod treats the end of the session's next turn as claude-session-pool-compact-self::US-001/AC-05 and claude-session-pool-compact-self::US-001/AC-08 state for the turn of the call.
- claude-session-pool-compact-self::US-001/AC-07: When the compaction does not complete for any other reason (Claude Code refuses it, it fails, or a hook vetoes it), the mod starts a turn in the session, and the model is handed the sentence `The compaction this session requested with compact_self did not complete: <reason>. Continue the work that was in progress, and do not call compact_self again in this turn.`, in which `<reason>` is what Claude Code reported. The request is used up, and the mod does not ask again.
- claude-session-pool-compact-self::US-001/AC-08: The mod drops the request, compacts nothing and starts no turn in each of these cases: the turn at whose end the compaction was due ended because the owner interrupted it; that turn ended on an API error or on a refusal by the model; the session's conversation was cleared before the compaction ran. When the owner cancels the compaction while it runs, the mod does not ask again and starts no turn.
- claude-session-pool-compact-self::US-001/AC-09: A call that a subagent of the session makes is refused by the mod with an error stating that only the session itself can call `compact_self`. It leaves no request, and it does not reach the server.
- claude-session-pool-compact-self::US-001/AC-10: A call made while a request of the same conversation stands is answered as the first one was and changes nothing else: the conversation is compacted once.

### claude-session-pool-compact-self::US-002 Compact my own conversation where the mod does not run

As a session in which the plugin's mod does not run, I compact my own conversation and continue afterwards, so that the owner neither types `/compact` into my window nor tells me to go on.

- claude-session-pool-compact-self::US-002/AC-01: When the server handles the call, it types `/compact` into the Terminal tab that hosts the attached session, without bringing that window to the front and without interrupting the turn in progress.
- claude-session-pool-compact-self::US-002/AC-02: Before it types, `compact_self` leaves a wake request for the attached session's conversation. It returns success once the session's transcript shows `/compact` queued on its own. The result states that the command runs when the current turn ends and that the session is woken after the compaction.
- claude-session-pool-compact-self::US-002/AC-03: When the transcript shows the command queued as part of a longer text, which happens when text was sitting in the session's input box, `compact_self` returns an error that quotes the queued text and states that no compaction will run. It withdraws the wake request, so nothing wakes the session later.
- claude-session-pool-compact-self::US-002/AC-04: When the transcript shows nothing queued 10 seconds after the typing, `compact_self` returns the result "unconfirmed". The wake request stays, so a compaction that the command starts later still wakes the session.
- claude-session-pool-compact-self::US-002/AC-05: When a compaction started by `/compact` finishes in a session whose conversation has a wake request, the plugin's hook wakes the session: the session starts a turn with nothing typed into its window, and the model is handed the sentence of claude-session-pool-compact-self::US-001/AC-03. That uses the request up.
- claude-session-pool-compact-self::US-002/AC-06: `compact_self` refuses, types nothing and leaves no wake request in each of these cases: the attached session is not listed as a live interactive session; its state is not `busy`, in which case the error states the state and, for `waiting`, what the session is waiting for; its transcript cannot be found or read; no Terminal tab hosts it; the plugin's hooks do not run in the attached session ([claude-session-pool-plugin::REQ-001/AC-02](claude-session-pool-plugin.md)); the session's conversation has a wake request that was left less than 30 minutes ago.
- claude-session-pool-compact-self::US-002/AC-07: A wake request does not lapse. Unless the `compact_self` call that left it withdraws it before returning, it stays until a compaction finishes in that conversation that `/compact` started, whoever typed the command, or that the mod asked for (claude-session-pool-compact-self::US-001/AC-05), or until a later `compact_self` call replaces it, which claude-session-pool-compact-self::US-002/AC-06 allows once it is 30 minutes old. The hook wakes no session after a compaction Claude Code started on its own, and none whose conversation has no wake request. A wake request belongs to one conversation: after `/clear` the session has a new session ID, and the request left for the old one no longer applies to it.

## Constraints

### claude-session-pool-compact-self::CON-001 Terminal on macOS only for a call the server handles (direct acceptance)

Applies to: a `compact_self` call the server handles; the session runs in a window of the macOS Terminal application (ADR-0001), and a call from a session in any other terminal is refused. A call the mod answers types nothing and does not script Terminal.

## Failure modes and boundaries

- **Terminal cannot be scripted** (macOS refuses the automation request, or Terminal reports an error) in a call the server handles: the tool returns that error text and withdraws the wake request it left.
- **The roster file cannot be parsed**: `compact_self` does not read the roster and is not affected.
- **A call of a pool tool is in progress**: `compact_self` does not wait for it.
- **A prompt is on screen when `compact_self` is called**, for example because another tool call of the same turn waits for a permission answer: the session's state is `waiting`, and the tool refuses (claude-session-pool-compact-self::US-002/AC-06). A prompt that comes up after the tool read the session's state is not detected: the command is typed while it is on screen, and its Return accepts the answer the prompt highlights.
- **Text is typed into the session during the turn of a call the mod answered**: Claude Code hands it to the model during that turn. When it is still queued as the turn ends, the mod's compaction runs first, Claude Code then starts a turn with the text, and the turn the mod starts follows that one. Either way the conversation is compacted once and the session is woken once.
- **Claude Code compacts the conversation on its own between a call the mod answered and the end of the turn**: the mod still asks for a compaction when the turn ends. When Claude Code refuses it because too little is left to compact, claude-session-pool-compact-self::US-001/AC-07 applies.
- **The session ends while the mod holds a request**: the request is kept in the session's process only, so it is gone, and a session resumed later is not compacted.
- **The mod is loaded again while it holds a request or while a compaction it asked for runs**: what the mod held is gone, which can leave the conversation compacted and the session not woken, with nothing to report it.
- **The conversation has a wake request and the plugin's hooks do not run in the session**: the mod leaves the waking to a hook that does not run, and the session stays idle after the compaction.
- **The plugin's hooks are switched off after the hook record was written**: a call the server handles types the command, the compaction runs, and nothing wakes the session.
- **The turn the mod starts after a compaction cannot be started**, because Claude Code or another plugin's hook drops the mod's prompt: the session stays idle, and nothing reports it.
- **A `Stop` hook keeps the turn of the call from ending**: what the mod is told then has not been measured, so it is not known whether the compaction runs late, runs more than once or is dropped. The plugin declares no `Stop` hook.
- **A subagent of the session calls `compact_self`** where the server handles the call: the server cannot tell the call from one made by the session itself, and it compacts the session.

## Implementation Decisions

### Facts about Claude Code and Terminal the behaviour rests on

The session listing, typing, the transcript and the hosting tab are described in [claude-session-pool](claude-session-pool.md), and hooks, the mod and the attached session in [claude-session-pool-plugin](claude-session-pool-plugin.md).

- **Typing during a turn.** The character U+0003 ends a turn in progress, so `compact_self` types `/compact` without it. Text typed during a turn goes into the input box at the cursor, and on Return the whole content of the box is queued, so that a typed `/compact` is queued as part of any text that sat in the box; the transcript records it at once as a record with `"type": "queue-operation"`, `"operation": "enqueue"` and the queued text as `content`. A queued slash command runs when the turn ends. A queued text that is not a slash command is handed to the model during the turn in progress, before any queued slash command runs.
- **A session's state during a tool call.** The session reports `busy` while one of its tool calls is in progress, and `waiting` while a prompt is on screen. A Return typed while a permission prompt is on screen accepts the answer the prompt highlights, which approves what the prompt asked about; text typed with it is not queued.
- **After a compaction.** A compaction started by `/compact`, or one a mod asked for, leaves the session idle; nothing continues its work until a message arrives, a hook wakes it or a mod submits a prompt.
- **`PostCompact` hooks.** Claude Code runs a plugin's `PostCompact` hooks when a compaction has finished. They receive the session's `session_id` and `trigger`, which is `manual` for a compaction started by `/compact` or asked for by a mod, and `auto` for one Claude Code started on its own. A command hook that is declared with `asyncRewake` and exits with code 2 makes an idle session start a turn at once. Claude Code hands the model what the hook wrote to its standard error stream, inside a system reminder that reads `Stop hook blocking error from command "PostCompact:manual": ` followed by that text. Measured on Claude Code 2.1.322.
- **A mod and a compaction.** The mod can ask Claude Code to compact the conversation. Claude Code rejects that when it is asked while the mod is answering a tool call, and while a turn or another compaction is in progress, with a message that says a conversation compacts between turns; it reports a compaction that a hook vetoed, and, when the user presses Escape during the compaction, rejects it with a message that ends in `Compaction canceled.` The mod can submit a prompt, which starts a turn once the session is idle; the model reads it as `The cc-session-pool plugin sent a message:`, the text, and a closing remark of Claude Code's that a plugin submitted this prompt between turns. Claude Code drops such a prompt when the user has stopped the session and typed nothing since. Measured on Claude Code 2.1.322.

### The hook and wake requests

- The plugin's hook on `PostCompact`, with the matcher `manual` and declared with `asyncRewake`: when the conversation named by `session_id` has a wake request, the hook deletes the request, writes the sentence of claude-session-pool-compact-self::US-001/AC-03 to its standard error stream and exits with code 2. Otherwise it writes nothing and exits with code 0.
- A wake request is the file `~/.claude-session-pool/wake-requests/<sessionId>.json`. Content: a JSON object with `version` (the number `1`), `sessionId` and `requestedAt`, the time `compact_self` left it, in ISO 8601 form in UTC.

### The mod's part

- The mod holds at most one request for a session, in the memory of the session's process, and writes no file for it. A request records the session ID of the conversation it was made in; claude-session-pool-compact-self::US-001/AC-08 takes the conversation as cleared when the session has another ID at the moment the compaction is due.
- It takes a refusal of the compaction as caused by a turn in progress (claude-session-pool-compact-self::US-001/AC-06) when it has been told of a turn of the session that started and has not ended, or when the refusal's message says that a conversation compacts between turns.
- It takes a refusal whose message ends in `Compaction canceled.` as the owner's cancellation (claude-session-pool-compact-self::US-001/AC-08).
- Before it asks for the compaction, the mod reads the conversation's wake request and counts it only when the hook would: valid JSON in the form stated above, naming the conversation. A file it cannot read counts as absent.

## Out of Scope

- **Compacting another session with `compact_self`.** The tool has no argument that names a session; a dispatcher session compacts a slot with `compact` ([claude-session-pool::US-004](claude-session-pool.md)).
- **Choosing what the model is told after a self-compaction.** It is always the sentence of claude-session-pool-compact-self::US-001/AC-03, or that of claude-session-pool-compact-self::US-001/AC-07 when the compaction did not complete; what the session does next is its own decision.
- **Cleaning up wake requests.** A wake request whose compaction never comes is a small file that stays; nothing deletes it.
