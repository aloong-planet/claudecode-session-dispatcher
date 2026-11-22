# claude-session-pool-context-usage

## Problem Statement

A session cannot see the size of its own context. Claude Code's status line shows it to the owner and not to the model, so a session whose instructions make compacting depend on that size works it out from its own transcript, a file Claude Code does not document as a stable interface, or does not know it.

## Solution

Every session in which the plugin's mod runs has a tool that reports the size of its own context as Claude Code's status line has it.

## User Stories

### claude-session-pool-context-usage::US-001 Know the size of my own context

As a session, I learn the size of my own context when I need it, so that I decide whether to compact from the figure Claude Code itself has, without working it out from my transcript.

- claude-session-pool-context-usage::US-001/AC-01: In a session in which the plugin's mod runs, interactive or not, the mod offers the tool `context_usage` from the start of the session, with its definition in the tool list, so the session calls it without first searching for it, unless Claude Code refuses it (claude-session-pool-context-usage::US-001/AC-06). The tool takes no arguments and reports on no session but the one that calls it. A session in which the mod does not run has no such tool: the server offers none.
- claude-session-pool-context-usage::US-001/AC-02: `context_usage` returns three figures as Claude Code's status line has them when the call is made: the input tokens of the session's latest model request, uncached, cache-written and cache-read together, which is the request that made the call; the context window of the session's model, in tokens; and the share of the window those input tokens fill, as a whole percentage.
- claude-session-pool-context-usage::US-001/AC-03: When Claude Code has no input figure or no share for the session, `context_usage` returns an error stating that the size of the context is not known, and gives no figure.
- claude-session-pool-context-usage::US-001/AC-04: When Claude Code fails to report the figures, `context_usage` returns an error that states the reason Claude Code gave, and gives no figure.
- claude-session-pool-context-usage::US-001/AC-05: A call that a subagent of the session makes is refused with an error stating that only the session itself can call `context_usage`. It gives no figure.
- claude-session-pool-context-usage::US-001/AC-06: When Claude Code refuses the mod's tool, as it does in a session started with no built-in tools, the session has no `context_usage`, and it starts and has its `compact_self` calls handled as it would without the tool. The mod then writes one line into Claude Code's debug log, and nowhere else, stating that `context_usage` is not offered in the session and the reason Claude Code gave.

## Failure modes and boundaries

- **Other tool calls are made in the same response as `context_usage`**: the figure is the input of the request that made the call (claude-session-pool-context-usage::US-001/AC-02), so the results of those calls, and that of `context_usage` itself, are not in it; they count from the next request on. A large result, such as a long file read in that response, is missing from the figure until a later call.

## Implementation Decisions

### The tool

The mod registers one tool of its own, `context_usage`, with no arguments. Claude Code offers a tool that a mod registers under the name `mcp__<plugin>__<tool>`, so a session sees it as `mcp__cc-session-pool__context_usage`, without the server's prefix. Its result is the text `Context: <tokens> input tokens of a <window>-token window (<percent>%). These are the input tokens of this session's latest model request, uncached, cache-written and cache-read together, as Claude Code's status line gives them (context_window.total_input_tokens).`, with each number written in decimal digits and no separators.

### Facts about Claude Code the behaviour rests on

The mod is described in [claude-session-pool-plugin](claude-session-pool-plugin.md).

- **A mod's own tool.** A mod can register a tool when it is told that the session starts. Claude Code lists the tool under `mcp__<plugin>__<name>`, in a session that is not interactive as well, puts its definition in the tool list from the start when the mod asks for that, and tells the mod of each call to it as of any other tool call. Claude Code refuses the registration in a session started with `--tools ""`, with an error whose message says that the session has no built-in tools and so takes none from plugins; a mod can write a line into Claude Code's debug log alone, led by the plugin's name. Measured on Claude Code 2.1.325.
- **The context figures.** A mod can read the figures of Claude Code's status line: the input tokens of the latest response, uncached, cache-written and cache-read together (`total_input_tokens`), the context window of the session's model (`context_window_size`), and the first over the second as a whole percentage (`used_percentage`). Claude Code documents the input figure and the percentage as absent until the first response after the session started or was compacted. Read while the mod answers a tool call, the input figure is that of the request that made the call, in the middle of a turn as well. Measured on Claude Code 2.1.325, in a session that was not interactive and in an interactive one; the absence before the first response is documented, not measured.

### The mod's part

The mod registers `context_usage` when it is told that the session starts, interactive or not, with its definition in the tool list from the start; a refusal is handled as claude-session-pool-context-usage::US-001/AC-06 states. It answers a call with the figures it reads at that moment, takes the size as not known when the input figure or the percentage is absent, and keeps nothing between calls.

## Out of Scope

- **The context size of another session.** `context_usage` has no argument that names a session, and `status` does not report the context size of a slot.
- **The context size where the mod does not run.** It is not worked out from the session's transcript.
- **`/context`'s breakdown by category.** `context_usage` gives the three figures of claude-session-pool-context-usage::US-001/AC-02 only.
