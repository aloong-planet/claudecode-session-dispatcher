# ADR-0001: Worker sessions are interactive sessions in Terminal windows

- Status: Accepted (2026-11-11)

## Context

A dispatcher session needs worker sessions that it can create, reset and close without the owner. Claude Code offers background sessions (`claude --bg`) with shell commands to manage them, and runs interactive sessions in terminal windows, which nothing in Claude Code can open, clear or compact from outside. The owner wants every worker session to be an ordinary terminal window that can be watched and typed into.

## Options

1. **Interactive sessions in macOS Terminal windows, driven through Terminal's scripting interface**
2. Background sessions (`claude --bg`, `claude stop`, `claude rm`). Rejected by the owner on 2026-11-10, who wants interactive sessions started in a terminal; they also may not edit the main checkout by default, are stopped after about an hour of idleness so that a cross-session message no longer reaches them, and have no window.
3. Agent teams. Rejected: the feature is experimental, teammates' permission prompts surface in the lead session, and teammates are not restored when the lead session is resumed.
4. Subagents of the dispatcher session. Rejected: their results return into the dispatcher session's own context, and the owner has no separate window in which to watch one or take it over.
5. tmux panes driven with `send-keys`. Rejected: it needs software that is not installed, and Terminal's own scripting interface does the same job.

## Decision

We run worker sessions as interactive Claude Code sessions in macOS Terminal windows (option 1). The server opens them with Terminal's `do script`, types `/compact` into their tabs, and closes their windows; it types `/clear` only where ADR-0003 does not deliver it.

## Consequences

- Positive: the owner sees every worker session as an ordinary window and can type into it. The sessions behave like the ones the owner used to open by hand, so the rest of the dispatcher session's procedure is unchanged.
- Positive: `/clear` and `/compact`, which Claude Code gives no way to trigger from outside a session, can be run without the owner.
- Negative: the server works only on macOS with the Terminal application.
- Negative: a newly opened window takes keyboard focus for a moment, and keystrokes the owner types in that moment land in it.
- Negative: commands are delivered as keystrokes. A message that reaches a session between the idle check and the typing has its turn interrupted.
- Neutral: confirming a compaction reads the session's transcript file, which Claude Code does not document as a stable interface.

## Sources

- `~/research/claude-code-session-pool/automating-dispatcher-session-pool.md` (2026-11-10): section 3.4 (measurements T1 to T12), section 5 (the options not chosen) and Appendix A (background sessions).
- The owner's decision of 2026-11-10: 「我不想使用后台 claude session， 我希望使用终端启动的交互式 session」.
