# claude-session-pool-startup

> Related: [ADR-0004](../adr/0004-one-plugin-installed-once.md)

## Problem Statement

Each time the dispatcher session is restarted, Claude Code gives it a new generated name, and the reports its worker sessions address to the old name no longer arrive. The session must also be known as the dispatcher session, and have the plugin, wherever the owner starts it.

## Solution

The repository's start-up command starts the dispatcher session. It keeps the session under one name across restarts, marks it as the dispatcher session, and gives it the plugin where the owner's installation does not reach it.

## User Stories

### claude-session-pool-startup::US-001 One name for the dispatcher session across restarts

As the owner, I start and resume the dispatcher session through the start-up command and it keeps one name, so that worker sessions keep reporting to a name that still answers.

- claude-session-pool-startup::US-001/AC-01: When its arguments start a new interactive session and give no name, the start-up command starts the session under the default name: the name of the directory the command is run in, followed by `-dispatcher`.
- claude-session-pool-startup::US-001/AC-02: When its arguments resume a session by session ID and that session's transcript shows a name that was given to it, the command adds no name, and the session keeps the name it has.
- claude-session-pool-startup::US-001/AC-03: When its arguments resume a session by session ID and that session's transcript shows no such name, the command starts the session under the default name.
- claude-session-pool-startup::US-001/AC-04: Before it uses the default name, the command lists the live sessions on this Mac. When one of them already answers to the default name, in any directory, the command starts nothing and prints that session's process ID and directory and the advice to pass `-n` with another name. When the sessions cannot be listed, it starts nothing and prints the reason and the same advice.
- claude-session-pool-startup::US-001/AC-05: The command adds no name and lists no sessions in each of these cases: the arguments give a name with `-n` or `--name`, which is used as given; they resume a session and the command cannot tell from them which local transcript is that session's, that is `-c`, `--continue`, `--from-pr`, `--teleport`, or `-r` or `--resume` with no value or with a value that is not a session ID; they contain `--fork-session`; they start no new interactive session in the terminal the command is run in, that is they contain `-p`, `--print`, `--bg`, `--background`, `--cloud`, `--environment`, `--desktop`, `-h`, `--help`, `-v` or `--version`. An option that begins with two hyphens is also recognised with a value attached to it by `=`, as in `--name=<name>`.
- claude-session-pool-startup::US-001/AC-06: When the arguments resume a session by session ID and that session's transcript cannot be found or read, the command adds no name, prints one line that says so, and starts the session.
- claude-session-pool-startup::US-001/AC-07: In the directory `/`, which has no name, the command builds no default name: where this story calls for one, it starts nothing and prints the advice to pass `-n`.

## Functional Requirements

### claude-session-pool-startup::REQ-001 The start-up command starts the dispatcher session (direct acceptance)

The repository provides one start-up command. It starts a Claude Code session, passing its arguments on to `claude`, gives that session the plugin as claude-session-pool-startup::REQ-002 states, and marks it as a dispatcher session ([claude-session-pool::REQ-006/AC-03](claude-session-pool.md)). It changes no user-level or project-level configuration.

### claude-session-pool-startup::REQ-002 Where the start-up command loads the plugin itself

- claude-session-pool-startup::REQ-002/AC-01: Before it starts the session, the start-up command finds out whether the plugin is installed and enabled in the directory it is run in, from the plugin's directory of the repository the command belongs to. When it is, the command does not load the plugin itself, and the session gets it from the installation. In every other case it loads the plugin from that directory for the session only: when the plugin is not installed; when it is installed and not enabled in that directory, by any setting; and when the installation reads another copy of the plugin, such as one in another checkout of the repository. It also loads it whenever its arguments contain `--restricted`, `--setting-sources` or `--settings`, with or without a value attached by `=`, whatever the listing shows.
- claude-session-pool-startup::REQ-002/AC-02: When the start-up command cannot find out, because the listing of installed plugins fails or its output cannot be read, it loads the plugin for the session only, as claude-session-pool-startup::REQ-002/AC-01 does when the plugin is not installed, prints one line that gives the reason, and starts the session.
- claude-session-pool-startup::REQ-002/AC-03: A session the start-up command starts while the plugin is installed is offered each tool of the server that its kind of session gets ([claude-session-pool::REQ-006/AC-01](claude-session-pool.md), [claude-session-pool-compact-self::US-001/AC-01](claude-session-pool-compact-self.md)) once and under the same names as without the installation; each hook runs there once for an event, and the mod answers a call to `compact_self` once and offers `context_usage` once, unless Claude Code refuses it ([claude-session-pool-context-usage::US-001/AC-06](claude-session-pool-context-usage.md)).

## Constraints

### claude-session-pool-startup::CON-001 Control characters in what the command reads

Applies to: the start-up command.

- claude-session-pool-startup::CON-001/AC-01: When the name of the directory the start-up command is run in contains a control character, the command does not build a default name from it: where claude-session-pool-startup::US-001 calls for the default name, it starts nothing and prints the advice to pass `-n`.
- claude-session-pool-startup::CON-001/AC-02: When the path of the plugin's directory contains a control character, the start-up command starts nothing, whatever arguments it was given, and prints the reason.

## Failure modes and boundaries

- **The owner gives the dispatcher session a name that a live session already has**: the start-up command does not check a name it was given (claude-session-pool-startup::US-001/AC-05), and Claude Code accepts the duplicate. A message addressed to that name may then reach either session.
- **A session resumed under claude-session-pool-startup::US-001/AC-06 had no name**: Claude Code gives it a new generated name, as it does without the start-up command.

## Implementation Decisions

### The command

The start-up command of claude-session-pool-startup::REQ-001 runs `claude` with the arguments it was given, followed by a name where claude-session-pool-startup::US-001 calls for one, followed, where claude-session-pool-startup::REQ-002 calls for it, by `--plugin-dir` and the absolute path of the plugin's directory in the repository. Before it does so it marks the session: it sets the environment variable `CLAUDE_SESSION_POOL_DISPATCHER_PID` to its own process ID and then replaces itself with `claude`, which keeps that process ID. The server's side of this is in [claude-session-pool](claude-session-pool.md), under "Which session is the dispatcher session".

It takes the plugin as installed and enabled (claude-session-pool-startup::REQ-002/AC-01) when `claude plugin list --json`, run in the directory the command is run in, lists an entry whose `id` is `cc-session-pool@cc-session-pool`, whose `enabled` is `true` and whose `readFromFolder` is the plugin's directory in the repository; the two directories are compared after resolving symbolic links. A listing that exits with an error or has not finished after 60 seconds fails; output that is not a JSON list, or an entry with that `id` whose `enabled` is not a boolean, is output that cannot be read (claude-session-pool-startup::REQ-002/AC-02).

The command looks for the transcript of a session it resumes as the server does ([claude-session-pool](claude-session-pool.md), "Transcript").

### Facts about Claude Code the command rests on

- **Session names.** Claude Code gives a session that is started without a name a generated name, and generates a new one every time that session is started or resumed; the generated name is not stored. A name given with `-n` or `--name`, at a start or at a resume, or with `/rename`, is stored in the session's transcript as a record with `"type": "custom-title"` and the name as `customTitle`. Claude Code restores a stored name on every later resume and keeps it across `/clear`. A name given at a resume replaces a stored one. Claude Code accepts two live sessions under one name.
- **Session IDs.** A session ID has the form of a UUID: 8, 4, 4, 4 and 12 hexadecimal digits joined by hyphens.
- **Options of `claude` that resume a session or start none in the terminal.** By the help text of Claude Code 2.1.322: `--from-pr` resumes a session linked to a pull request; `--teleport` resumes a session that ran in the cloud; `--bg` and `--background` start the session in the background; `--cloud` and `--environment` create a cloud session, and `--cloud` can also attach to one; `--desktop` opens the session in the desktop application instead of the terminal.
- **Installed plugins.** `claude plugin list --json` prints a JSON list with one entry per installation. The start-up command uses `id` (`<plugin>@<marketplace>`), `enabled` and `readFromFolder`. `enabled` states whether the plugin is enabled in the directory the command is run in: a project setting that disables it there makes it `false`, and a session started there then does not load the plugin. `readFromFolder` is the directory a plugin used in place is read from. The listing does not know the options a session will be started with: a session started with `--restricted`, with `--setting-sources` that leaves out `user`, or with `--settings` that disable the plugin does not load the installed plugin although the listing shows it as enabled, and does load one given with `--plugin-dir`. Under `--strict-mcp-config`, `--safe-mode` or `--bare` a session gets the plugin's server neither way. Measured on Claude Code 2.1.322; Claude Code does not document this output as a stable interface, which claude-session-pool-startup::REQ-002/AC-02 covers.

## Out of Scope

- **Running `claude` subcommands through the start-up command.** The command adds its arguments to whatever it is given, as for a session start, and a subcommand such as `agents` or `mcp` rejects them. Subcommands are run with `claude` itself.
- **Names of sessions other than the dispatcher session.** A worker session the server opens is named after its slot; a session the owner starts or adopts keeps whatever name Claude Code or the owner gave it.
