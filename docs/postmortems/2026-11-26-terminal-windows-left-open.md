# Windows that `close` could not close, and a dead window taken for a live one

Spec: [claude-session-pool](../specs/claude-session-pool.md), claude-session-pool::US-006/AC-01 and AC-02, and its facts "Which window hosts a session" and "Closing a window".

## What happened

- A `close` left a Terminal window open for good, under the sheet "Do you want to terminate running processes in this window?".
- Another `close` tried a window whose session had already ended, while the session it was closing ran in a different window, and so left that window open.

## Causal chain

1. `close` ended the session's process, waited for that process to exit, and asked Terminal to close the window at once.
2. The processes the session had started, such as tool servers, could still be in the tab at that moment. Terminal asks before closing a window in which a process runs, and that sheet keeps the window open until someone answers it.
3. A window left open after its session ended, as in step 2, has a tab with no process. That tab keeps the terminal device it had, and the system gives that device to a window opened later.
4. The tab lookup took the first tab with the device, so it could return such a dead window in place of the live one. `close`, and the commands typed into a slot, then acted on the wrong window.

## Why the checks did not catch it

- The unit tests do not reach the AppleScript, and the test double of the Mac closed a window whenever asked. It modelled neither Terminal's sheet nor a dead tab keeping its device.
- The live Terminal test ran a program that ended before its window was closed, and opened one window at a time, so neither the sheet nor a reused device came up.

## Defences now in place

- The test double puts up the sheet while processes of the window's own process group run on its device. Its lookup passes over a tab with no process, and a later window can be given a device that another window left.
- Tests: `close` waits for the processes the session started (claude-session-pool::US-006/AC-01). It leaves the window open and names what is left at the limit (AC-02). A window that gets the device during the wait is not taken for the session's leftovers.
- A live Terminal test gives a later window the device of a window whose program ended, puts the dead window first in Terminal's order, and checks that the lookup returns the live one.
