# ADR-0002: A hook wakes a session after it compacts itself; the server and the hooks are one plugin

- Status: Proposed

## Context

A compaction started by `/compact` leaves a session idle, so a session that compacts itself with `compact_self` needs something to make it carry on. The server did this itself: after the tool had returned it read the session's transcript, waited for the compaction record and for the session to be idle, and typed `continue` into its window. It typed nothing when the session was not idle within 60 seconds of the record, or when no compaction was recorded within 30 minutes; the session then stayed stopped and nobody was told. Claude Code runs `PostCompact` hooks when a compaction has finished, and a command hook declared with `asyncRewake` that exits with code 2 makes an idle session start a turn. A hook has to be declared where every session reads it. The server has to reach every session too; one user-level MCP registration was planned for that and was never made.

## Options

1. **A `PostCompact` hook wakes the session. The server and the hooks are one Claude Code plugin, which the start-up command loads with `--plugin-dir` and the owner installs once at user scope from a marketplace in the repository.**
2. The server keeps typing `continue` once it sees the session idle. Rejected by the owner on 2026-11-11: it keeps the two cases above in which the session stays stopped.
3. The hook wakes the session, and the server's typing stays as a fallback for a session without the hook. Rejected: there are two mechanisms to maintain and test, and on the fallback path both time limits remain, as does the moment before the typing in which a message that arrives has its turn interrupted.
4. The hook is declared in the user-level `settings.json` and the server keeps a user-level MCP registration, so that tool names stay as they were. Rejected: the two are installed separately, so a session can have the server without the hook, and such a session is not woken; it also means editing the owner's settings file.
5. The plugin of option 1, with the start-up command still passing the server by `--mcp-config`. Rejected: Claude Code then connects the server once, under the `--mcp-config` definition, so the same tool has one name in a dispatcher session and another in every other session, and documents and permission rules would carry both.
6. The plugin of option 1, with the start-up command relying on the installed plugin alone. Rejected: without the installation a dispatcher session has no tools, and the command would have to check for the installation and refuse to start.
7. The plugin of option 1, installed by a symbolic link in `~/.claude/skills/` instead of a marketplace. Rejected: the documentation does not say whether a symbolic link counts, and it was not measured; such a plugin has the id `<name>@skills-dir`, which some management settings treat differently.
8. The plugin of option 1, with the repository's root as the plugin's directory. Rejected: Claude Code puts the files in `bin/` at a plugin's root on the `PATH` of the Bash tool in every session that has the plugin, which would hand `claude-dispatcher` to all of them. The plugin's directory is `plugin/`, and its declarations reach the programs in the repository from there.
9. The plugin of option 1 under the name `claude-session-pool`, after the product. Chosen first, on 2026-11-11, and rejected by the owner on 2026-11-12: `claude plugin validate` refuses a plugin name that starts with `claude-`, as one that passes for Anthropic's own. Claude Code 2.1.322 still installs and loads a plugin under such a name, but the validator could then not serve as a check of the manifest, and a later version might refuse the name where it matters.

## Decision

We wake a session after a compaction it asked for with a `PostCompact` hook, and we deliver the server and its hooks as one Claude Code plugin (option 1).

- `compact_self` leaves a wake request for its conversation before it types `/compact`. The hook is declared with `asyncRewake`. When the compacted conversation has a wake request, the hook exits with code 2, and Claude Code starts a turn and hands the model one fixed sentence. After `compact_self` has returned, the server does nothing more.
- A second hook, on `SessionStart`, records that the plugin's hooks run in a session. `compact_self` refuses when it finds no such record for its attached session.
- The plugin is named `cc-session-pool` and its server `pool`. The start-up command loads the plugin with `--plugin-dir` for the dispatcher session. Every other session gets it from one installation at user scope, which the owner makes from a marketplace of the same name in the repository. That installation replaces the planned user-level MCP registration.

This record stays Proposed until the plugin has been installed in the owner's own configuration and a session there, started without the start-up command, has compacted itself and been woken. What the decision first rested on from the documentation alone has been measured since: under a throwaway configuration directory the plugin, installed at user scope from the local marketplace, is used in place, and a plugin given with `--plugin-dir` takes the place of the installed plugin of the same name; in a real Terminal window, with the plugin loaded by `--plugin-dir`, a session compacted itself and the hook woke it.

## Consequences

- Positive: a session is woken at the moment its compaction finishes, with nothing typed into its window. The 60-second and 30-minute waits are gone, and with them the two cases in which a session stayed stopped because a wait had run out.
- Positive: the server keeps no wait running after `compact_self` has returned.
- Positive: a session that has the tool has the hooks, because one plugin carries both, and a tool has the same name in every session.
- Positive: a plugin listed in a marketplace that was added from a local directory is used in place, so a change in the repository reaches every session started after it.
- Negative: every tool is renamed to `mcp__plugin_cc-session-pool_pool__<tool>`. Whatever names a tool, such as a permission rule or a written procedure, has to follow.
- Negative: Claude Code hands the model the hook's sentence as `Stop hook blocking error from command "PostCompact:manual": …`. The sentence therefore has to say that it is not an error, and whether the session carries on depends on how the model reads it. Of the four wakes that were measured, the model carried on as it had been asked to in three.
- Negative: the wake rests on behaviour that Claude Code's documentation does not state for this event: the hooks page describes `asyncRewake` in general and does not say that it applies to `PostCompact`. It was measured on Claude Code 2.1.322. If a later version changes it, a session that compacts itself stays stopped, and nothing reports that.
- Negative: a session in which the plugin's hooks do not run cannot compact itself, because `compact_self` refuses there. Hooks that are switched off after the record was written are not detected, and such a session stays stopped after its compaction.
- Negative: there are two more kinds of file under `~/.claude-session-pool/`, hook records and wake requests. A wake request does not lapse, so one whose compaction never came makes a later `/compact` that someone types into that conversation wake the session.
- Negative: once the plugin is installed, every Claude Code session of the user runs the plugin's hook at each start, clear and compaction, in addition to the server process that the planned registration would also have started.
- Negative: the plugin works only where Claude Code uses it in place, because the programs its declarations run, and the packages the server needs, lie in the repository outside the plugin's directory. A marketplace from which Claude Code copies the plugin, such as one on a git host, does not work.
- Neutral: the plugin and its marketplace are not named after the product. The repository, the spec, the package and the directory `~/.claude-session-pool/` keep the name `claude-session-pool`.
- Neutral: the installation at user scope is the owner's step and writes to the owner's Claude Code settings. The user-level MCP registration it replaces was never made, so nothing has to be migrated.
- Neutral: `compact` on a slot is unchanged. It still types the command and confirms the compaction from the worker session's transcript.

## Sources

- `~/research/claude-code-session-pool/automating-dispatcher-session-pool.md`, sections added on 2026-11-11 and 2026-11-12 on Claude Code 2.1.322: section 3.9 (a session typing `/compact` into its own window, and its state after the compaction), section 3.10 (the hooks around a compaction: documentation excerpts and three measurements), section 3.11 (how the hooks and the server reach every session: documentation excerpts, and two measurements with a plugin loaded by `--plugin-dir`) and section 3.12 (reserved plugin names, a plugin's `bin/` directory, the installation under a throwaway configuration directory with and without `--plugin-dir`, and one self-compaction in a real Terminal window).
- Claude Code documentation read on 2026-11-11, under `https://code.claude.com/docs/en/`: `hooks.md`, `mcp.md`, `plugins-reference.md`, `plugins/components.md`, `plugins/install.md`, `plugins/loading.md`, `plugins/create.md` and `plugins/cli-reference.md`.
- The owner's question of 2026-11-11 that started the change: whether no hook can catch the end of a compaction, asked about the case in which the session is not idle within 60 seconds of it.
- The owner's choices of 2026-11-11, each made among options that were put with their costs: the hook wakes the session; the server and the hooks are one plugin; the model is handed one fixed sentence; the start-up command uses `--plugin-dir`; the plugin is installed from a marketplace in a local directory; the names are `claude-session-pool` and `pool`; `compact_self` refuses when it cannot confirm that the hooks run; a wake request does not lapse. On 2026-11-12 the owner asked for this record, and, once the validator's rule on names was known, renamed the plugin `cc-session-pool` and gave the marketplace the plugin's name.
