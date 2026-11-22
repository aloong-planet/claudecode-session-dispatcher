# ADR-0002: A self-compacting session is woken by the plugin's mod, or by a hook where the mod does not run

- Status: Proposed

## Context

A compaction started by `/compact` leaves a session idle, so a session that compacts itself needs something to make it carry on. A `PostCompact` hook declared with `asyncRewake` that exits with code 2 makes an idle session start a turn, and a plugin's mod, loaded into the session's own process, can answer a tool call, ask for a compaction between turns and submit a prompt that starts a turn.

## Options

1. **Where the plugin's mod runs, it answers `compact_self`, compacts the conversation when the turn ends and starts the next turn; elsewhere the server types `/compact` and a `PostCompact` hook wakes the session.**
2. The server types `continue` once it sees the session idle. Rejected by the owner on 2026-11-11: the session stays stopped, unnoticed, when it is not idle within 60 seconds of the compaction record or no record comes within 30 minutes.
3. The hook wakes the session and the server's typing stays as a fallback. Rejected: two mechanisms to maintain and test, and the fallback keeps both time limits and the interrupted turn of a message that arrives before the typing.
4. The hook alone wakes the session, with no mod. Set aside by the owner on 2026-11-12: it works only in Terminal windows, types into the window, and the model reads the wake as a hook's blocking error.
5. The mod compacts and the hook stays the only waker, after a wake request the mod leaves. Withdrawn on 2026-11-12: a failed, vetoed or cancelled compaction runs no `PostCompact` hook, so the mod would have to start the turn itself there anyway.
6. The mod alone, with the typing, hooks, hook records and wake requests removed. Rejected by the owner on 2026-11-12: a session in which the mod does not run could not compact itself.
7. The mod registers a tool beside the server's `compact_self`. Rejected by the owner on 2026-11-12: the model would have to choose between two tools, and the written rule that names `compact_self` would have to follow.
8. The model writes the text its next turn starts with, as an argument of `compact_self`. Rejected by the owner on 2026-11-12: the hook's way has no such argument, so the two ways would behave differently, and the summary already carries the state of the work.

## Decision

We adopt option 1, as US-001 and US-002 of [claude-session-pool-compact-self](../specs/claude-session-pool-compact-self.md) state.

## Consequences

- Positive: where the mod runs, nothing is typed, the session need not run in a Terminal window, a failed or vetoed compaction is reported to the model in a new turn, and the model reads the mod's sentence as a message the plugin sent, not as a hook's blocking error.
- Positive: on the hook's way too a session is woken when its compaction finishes, and the server keeps no wait running.
- Negative: there are two ways to compact and wake, both to maintain and test, and the mod and the server share the location and form of the wake requests; the hook's way, taken only where the mod does not run, can hide a defect for long.
- Negative: the mod rests on Claude Code's interface for mods, measured on 2.1.322, and tells a cancelled compaction from a failed one by the wording of Claude Code's message, so a later wording makes it start a turn the owner did not want.
- Negative: a request the mod holds lives in the session's process only: a session that ends before the turn does is not compacted when resumed, and a reload of the mod can leave the session compacted and not woken.
- Negative: the hook's sentence reaches the model as `Stop hook blocking error from command "PostCompact:manual": …`, so it has to say that it is not an error, and whether the session carries on depends on the model.
- Negative: the wake rests on `asyncRewake` applying to `PostCompact`, which Claude Code's documentation does not state (measured on 2.1.322); if a later version changes it, a session that compacts itself stays stopped, unreported.
- Negative: a session in which neither the mod nor the plugin's hooks run cannot compact itself, and hooks switched off after the hook record was written are not detected.
- Negative: hook records and wake requests are two more kinds of file under `~/.claude-session-pool/`, and a wake request does not lapse, so a later `/compact` typed into that conversation wakes the session.
- Neutral: `compact` on a slot is unchanged: it types the command and reads the worker session's transcript.

## Sources

- `~/research/claude-code-session-pool/automating-dispatcher-session-pool.md`, sections 3.9 and 3.10, and `compact-self-equivalents-in-plugin-marketplaces.md`, sections 9, 17 and 18, on Claude Code 2.1.322: four wakes through the hook, in three of which the model carried on as asked; section 17 is read from the program.
- The owner's choices of 2026-11-11 and 2026-11-12.
