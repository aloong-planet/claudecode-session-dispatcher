# ADR-0001: Worker sessions are interactive sessions in Terminal windows, and are cleared through the plugin's mod where its hooks run

- Status: Accepted (2026-11-25)

## Context

A dispatcher session needs worker sessions that it can create, reset and close without the owner. Claude Code runs interactive sessions in terminal windows, which no built-in command can open, clear or compact from outside, and the plugin's mod can run `/clear` inside a session but the server cannot call it. The owner wants every worker session to be an ordinary terminal window; a typed `/clear` failed twice while the Mac's screen was locked.

## Options

1. **Interactive sessions in macOS Terminal windows, driven through Terminal's scripting interface, except that `/clear` is a clear order that the plugin's mod acts on when Claude Code's file watch notifies it; the server types it only where the plugin's hooks do not run in the worker.**
2. Background sessions (`claude --bg`). Rejected by the owner on 2026-11-10, who wants interactive sessions started in a terminal; they also may not edit the main checkout by default, stop after about an hour idle (a cross-session message then no longer reaches them), and have no window.
3. Agent teams. Rejected: the feature is experimental, teammates' permission prompts surface in the lead session, and teammates are not restored when the lead session resumes.
4. Subagents of the dispatcher session. Rejected: their results return into its own context, and the owner has no window to watch one or take it over.
5. tmux panes driven with `send-keys`. Rejected: it needs software that is not installed, and Terminal's scripting interface does the same job.
6. The mod checking for clear orders once a second. Rejected by the owner on 2026-11-21: it makes about 3,600 checks an hour in every idle worker for no gain in speed.
7. A cross-session message that the worker's mod answers with the clear. Rejected: the server cannot send one, so the dispatcher's mod would have to take the `clear` call and repeat the server's lookup, wait and confirmation in code that cannot import it.
8. Typing `/clear` into every worker, as before. Rejected by the owner on 2026-11-21: it failed twice on a locked screen.
9. Refusing to clear a worker without the plugin. Rejected: such a worker could not be cleared.
10. A key file that the clear order must match, or the mod also refusing an order for the dispatcher session. Not adopted by the owner on 2026-11-22: neither stops a process of the same user, which could already type `/clear` into any tab.
11. The server writes the clear order at once and the mod waits for the turn to end. Rejected by the owner on 2026-11-21: `clear` waits for idleness and refuses after 60 seconds, as the typed way does.

## Decision

We adopt option 1: the server opens worker sessions in Terminal windows with `do script`, types `/compact` into them, closes them, and delivers `/clear` as [claude-session-pool::REQ-007](../specs/claude-session-pool.md) states.

## Consequences

- Positive: the owner sees every worker session as an ordinary window and can type into it.
- Positive: `/clear` and `/compact` can be run without the owner; a clear through the mod needs no Terminal tab or keyboard focus and does not poll.
- Negative: the server works only on macOS with the Terminal application.
- Negative: a newly opened window takes keyboard focus for a moment, so keystrokes the owner types then land in it.
- Negative: commands are delivered as keystrokes. A message that reaches a session between the idle check and the typing has its turn interrupted.
- Negative: of the tools that script Terminal, only a typed `clear` has been measured on a locked screen.
- Negative: the mod rests on Claude Code's file watch, measured on 2.1.327 only; if a version changes it, the mod is loaded again, or the mod does not run where the hooks do, the clear is reported as unconfirmed and not typed.
- Negative: a process of the same user that writes a clear order for a session's current ID clears that session, the dispatcher session included, as typing into Terminal could.
- Negative: there are two ways to clear to maintain and test, and the typed way, taken only for a worker without the plugin, can hide a defect for long. The server and the mod are kept in step by hand on where clear orders lie and what they hold.
- Neutral: confirming a compaction reads the session's transcript file, an interface Claude Code does not document as stable.
- Neutral: a typed `/clear` and a clear order worked on a locked screen, display off, for up to five minutes; a longer lock is not measured.

## Sources

- In `~/research/claude-code-session-pool/`:
  - `automating-dispatcher-session-pool.md` (2026-11-10): sections 3.4 and 5, and Appendix A.
  - `compact-self-equivalents-in-plugin-marketplaces.md`, section 19, on Claude Code 2.1.327: a check once a second cleared an idle worker in 1.01 s, the file watch in 1.03 s.
  - `clear-on-locked-screen-2026-11-24/README.md`: the two failures and the locked-screen runs, Claude Code 2.1.327.
- The owner's decision of 2026-11-10: 「我不想使用后台 claude session， 我希望使用终端启动的交互式 session」.
