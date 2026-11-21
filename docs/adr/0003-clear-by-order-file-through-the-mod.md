# ADR-0003: A worker session is cleared by an order file that the plugin's mod acts on, and by typing only where the plugin does not run

- Status: Proposed

## Context

Typing `/clear` into a worker's Terminal tab fails while the Mac's screen is locked, because the server simulates the keyboard through Terminal. The plugin's mod runs inside every session that loads the plugin and can run `/clear` there once no turn is running. The server is a separate process: it can write files, but it cannot call the interface that the mod has.

## Options

1. **The server writes an order file that names the conversation to clear by its session ID and is valid for 60 seconds, and the mod, notified by Claude Code's file watch, runs `/clear` once no turn is running. Where the plugin's hooks do not run in the worker, the server types `/clear` as before.**
2. The same order file, with the mod checking the directory once a second. Rejected by the owner on 2026-11-21: it makes about 3,600 checks an hour in every idle worker, and the file watch clears an idle worker in the same time.
3. A cross-session message that the worker's mod takes in `session.receive` and answers with the clear. Rejected: the server cannot send one, so the dispatcher's mod would have to take the `clear` call and repeat the slot lookup, the idle wait and the confirmation in code that cannot import the server's.
4. Typing for every worker, as before. Rejected by the owner on 2026-11-21: it cannot clear a worker while the screen is locked.
5. Refusing to clear a worker without the plugin. Rejected: such a worker could not be cleared at all.
6. A key file that the order must match. Rejected by the owner on 2026-11-22: it stops only another user of the Mac, because a process of the same user reads the key too, as it can type into Terminal.
7. The mod also refuses an order for the dispatcher session. Not adopted by the owner on 2026-11-22: the server never writes one for it, and a process of the same user could already type `/clear` into any tab.
8. The server writes the order at once and the mod waits for the turn to end. Rejected by the owner on 2026-11-21: the wait for idleness and the refusal after 60 seconds stay as the typed way has them.

## Decision

We adopt option 1.

- Where the plugin's hook has left a hook record for the worker, `clear` waits up to 60 seconds for it to be idle and refuses if it is not. It then writes the order and reports the clear once the worker's session ID has changed within 30 seconds; when it has not, it reports the clear as unconfirmed, removes the order and does not type the command.
- The mod subscribes to the file watch for the directory of the orders and acts on an order only when its name and its content give the session's current ID and it is less than 60 seconds old.
- Where no hook record exists for the worker, `clear` types `/clear` as before and says so.
- `compact`, `open` and `recycle` are unchanged.

## Consequences

- Positive: clearing a worker that has the plugin types nothing, so it needs no Terminal tab and no keyboard focus.
- Positive: the mod does not poll; Claude Code notifies it, so an idle worker spends nothing waiting.
- Positive: an order applies to one conversation, so neither a late mod nor a leftover file can clear the conversation that the clear started.
- Negative: not measured are a clear on a locked screen, a reload of the mod, and another plugin that also returns paths to watch. The record stays Proposed until the owner has cleared a worker on a locked screen.
- Negative: the mod rests on the `watchPaths` that a `SessionStart` hook returns and on the `FileChanged` event, which were measured on Claude Code 2.1.327 only. If a later version changes them, a clear is reported as unconfirmed.
- Negative: where the plugin's hooks run and its mod does not, nothing clears the worker and the clear is reported as unconfirmed, and the server does not then type the command.
- Negative: a process of the same user that writes an order for a session's current ID clears that session, the dispatcher session included; typing into Terminal reaches as far.
- Negative: there are two ways to clear and both have to be maintained and tested. The typed way is taken only for a worker without the plugin, so a defect in it can stay unnoticed for long.
- Negative: the server and the mod have to agree on where orders lie and what they hold, and the mod cannot import the server's code, so the two are kept in step by hand.
- Neutral: `compact`, `open` and `recycle` still go through Terminal and still fail while the screen is locked.

## Sources

- `~/research/claude-code-session-pool/compact-self-equivalents-in-plugin-marketplaces.md`, section 19, on Claude Code 2.1.327: a cross-session message cleared a session in 23 ms; an order file checked once a second cleared an idle one in 1.01 s; with the file watch an idle one was cleared in 1.03 s, a busy one 0.02 s after its turn ended, and the watch survived the clear.
- The owner's choices of 2026-11-21 and 2026-11-22, each made among options that were put with their costs.
