# ADR-0004: The server, the hooks and the mod are one plugin, installed once at user scope

- Status: Proposed

## Context

Claude Code reads a tool server, a hook and a mod from different places, and the pool's features need all three in a session. The server is wanted in every session. A plugin installed at user scope loads in every session of its user and can carry a server, hooks and a mod, and Claude Code reads a plugin that a marketplace added from a local directory lists in place.

## Options

1. **One Claude Code plugin, `cc-session-pool`, carries the server `pool`, the hooks and the mod, in the directory `plugin/`. The owner installs it once at user scope from a marketplace in the repository, and the start-up command loads it with `--plugin-dir` where that installation does not reach the dispatcher session.**
2. The hook in the user-level `settings.json` and a user-level MCP registration of the server. Rejected: the two are installed separately, so a session can have the server without the hook and is not woken, and the owner's settings file has to be edited.
3. Option 1 with the start-up command still passing the server by `--mcp-config`. Rejected: the same tool then has one name in a dispatcher session and another in every other session.
4. Option 1 with the start-up command relying on the installed plugin alone. Rejected: without the installation a dispatcher session has no tools, and the command would have to check for it and refuse to start.
5. Option 1 installed by a symbolic link in `~/.claude/skills/` instead of a marketplace. Rejected: the documentation does not say whether a symbolic link counts, it was not measured, and such a plugin has the id `<name>@skills-dir`, which some management settings treat differently.
6. Option 1 with the repository's root as the plugin's directory. Rejected: Claude Code puts the files in `bin/` at a plugin's root on the `PATH` of every session that has the plugin, which would hand `claude-dispatcher` to all of them.
7. Option 1 under the name `claude-session-pool`. Rejected by the owner on 2026-11-12: `claude plugin validate` refuses a name that starts with `claude-`, so it could not serve as a check of the manifest, and a later Claude Code might refuse the name where it matters.

## Decision

We adopt option 1, as [claude-session-pool-plugin::CON-001](../specs/claude-session-pool-plugin.md) and [claude-session-pool-startup::REQ-002](../specs/claude-session-pool-startup.md) state.

## Consequences

- Positive: a session that has the tool has the hooks and the mod too, because one plugin carries all three, and a tool has the same name in every session.
- Positive: a plugin listed in a marketplace added from a local directory is used in place, so a change in the repository reaches every session started after it.
- Negative: every tool is renamed to `mcp__plugin_cc-session-pool_pool__<tool>`, so whatever names a tool, such as a permission rule or a written procedure, has to follow.
- Negative: the start-up command decides whether to load the plugin itself from the output of `claude plugin list --json`, which Claude Code's documentation does not state as a stable interface (measured on 2.1.322). When the output cannot be read the command loads the plugin with `--plugin-dir` and says why, so the dispatcher session keeps its tools.
- Negative: once the plugin is installed, every Claude Code session of the user runs the plugin's hook at each start, clear and compaction.
- Negative: the plugin works only where Claude Code uses it in place, because the programs its declarations run and the packages the server needs lie in the repository outside the plugin's directory; a marketplace from which Claude Code copies the plugin, such as one on a git host, does not work.
- Neutral: the plugin and its marketplace are not named after the product; the repository, the specs, the package and the directory `~/.claude-session-pool/` keep the name `claude-session-pool`.
- Neutral: the installation at user scope is the owner's step and writes to the owner's Claude Code settings.

## Sources

- `~/research/claude-code-session-pool/automating-dispatcher-session-pool.md`, sections 3.11 and 3.12, on Claude Code 2.1.322: how the hooks and the server reach every session, reserved plugin names, a plugin's `bin/` directory, and the installation under a throwaway configuration directory with and without `--plugin-dir`.
- Claude Code documentation read on 2026-11-11 under `https://code.claude.com/docs/en/`: `hooks.md`, `mcp.md`, `plugins-reference.md` and the `plugins/` pages on components, install, loading, create and cli-reference.
- The owner's choices of 2026-11-11, 2026-11-12 and 2026-11-13, each made among options put with their costs.
