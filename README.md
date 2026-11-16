# claudecode-session-dispatcher

`cc-session-pool` is a Claude Code plugin with two jobs:

- **Every session gets the tool `compact_self`.** A session uses it to compact its own conversation, and is woken afterwards so that it carries on, without anyone typing `/compact` or telling it to go on.
- **A dispatcher session gets nine more tools.** With them it manages a pool of worker sessions that run in Terminal windows. It can open them, reset or compact their conversations, read their state, and close or replace them.

What the plugin does, in full, is in the spec, [docs/specs/claude-session-pool.md](docs/specs/claude-session-pool.md).

## Requirements

- **macOS with the Terminal app.** Worker sessions run in Terminal windows. When a session's call to `compact_self` is handled by the plugin's server rather than its mod (see [Tools](#tools)), it also needs the session to run in a Terminal window. On first use, macOS asks whether the session's terminal may control Terminal; this must be allowed.
- **Claude Code 2.1.287 or later**, the version from which plugin mods are on by default. Only Claude Code 2.1.322 has been tested.
- **Node.js 22.18 or later**, found on the `PATH` of the sessions that load the plugin. The server and the hooks run on it directly, with no build step.
- **pnpm**, to install the packages the server needs.

Windows is not supported.

## Install

The plugin works only from a clone of this repository on the same Mac. Its server and hooks run programs that lie in the repository outside the plugin's directory, `plugin/`.

```sh
git clone https://github.com/aloong-planet/claudecode-session-dispatcher.git
cd claudecode-session-dispatcher
pnpm install
claude plugin marketplace add "$PWD"
claude plugin install cc-session-pool@cc-session-pool
```

- **Where it applies.** Installed this way, every Claude Code session of your user loads the plugin, in every directory, unless a setting disables it there.
- **Updates.** Claude Code uses the plugin in place, so a change in the clone reaches every session started after it.
- **Not from GitHub.** Adding the marketplace from GitHub instead of from the clone does not work: Claude Code then copies only the plugin's directory.

To remove it:

```sh
claude plugin uninstall cc-session-pool@cc-session-pool
claude plugin marketplace remove cc-session-pool
```

## Start a dispatcher session

Run `bin/claude-dispatcher` in the directory the pool should work in. Every argument is passed on to `claude`, for example `bin/claude-dispatcher --resume <session-id>`.

- **Name.** A new session that is given no name gets `<directory name>-dispatcher`. The same name is kept when you resume it, so worker sessions keep reporting to a name that still answers. Pass `-n <name>` to choose another.
- **The plugin.** When the plugin is installed and enabled in that directory from this clone, the session gets it from the installation. Otherwise the command loads it for that session alone with `--plugin-dir`, so a dispatcher session works without the installation too.
- **What makes a dispatcher session.** Only a session started through this command is a dispatcher session. Any other session, a worker session included, gets `compact_self` alone.

## Tools

A session sees each tool as `mcp__plugin_cc-session-pool_pool__<tool>`.

| Tool | Offered to | What it does |
|---|---|---|
| `compact_self` | every session | Compacts the session's own conversation when the current turn ends, then wakes the session. |
| `init`, `open` | the dispatcher session | Open worker sessions in new Terminal windows, in the pool's directory, and add them to the roster. |
| `adopt` | the dispatcher session | Adds a session you opened by hand to the roster. |
| `status` | the dispatcher session | Lists each slot's state: `idle`, `busy`, `waiting` (and for what), `gone` or `ambiguous`. |
| `clear`, `compact` | the dispatcher session | Type `/clear` or `/compact` into a worker session's Terminal tab and confirm that it took effect. |
| `close`, `recycle` | the dispatcher session | End a worker session, or end it and open a new one under the same name. |
| `release` | the dispatcher session | Takes a slot off the roster and leaves its session alone. |

`compact_self` works one of two ways:

- **With the mod.** In an interactive session in which the plugin's mod runs, the mod answers the call. Nothing is typed, and the session need not run in Terminal.
- **With the server.** Everywhere else the call reaches the plugin's server. The server types `/compact` into the session's Terminal tab, and the plugin's `PostCompact` hook wakes the session.

## Running the dispatcher

The plugin gives the dispatcher session its tools. Three things come from the instructions you give it, not from the plugin:

- how it dispatches;
- what it decides for you;
- where it stops.

**Where to put the instructions.** Worker sessions start in the same directory as the dispatcher session, so they read the same `CLAUDE.md`. Keep the dispatcher's instructions in a file of their own, for example `docs/dispatcher.md`. Then add one line to `CLAUDE.md`, such as: `If you have the tool mcp__plugin_cc-session-pool_pool__status, you are the dispatcher session: follow docs/dispatcher.md.` Only a dispatcher session has that tool.

**How the work moves.**

- **Tickets go out by message.** The plugin does not send work to a worker session. The dispatcher session sends each ticket in a Claude Code message between sessions, addressed to the worker's name.
- **Reports come back the same way.** The worker session reports by message to the dispatcher session's name. That name is why the start-up command keeps it the same across restarts.

An example `docs/dispatcher.md`, to adapt:

```markdown
# Dispatching

You are the dispatcher session. You hand tickets to worker sessions and check what they hand
back; the work itself is done in the worker sessions.

## The run

1. Open the worker sessions with `init`.
2. Send each idle worker one ticket in a message. Give it:
   - the ticket's path;
   - your session name, to report to;
   - what to hand back: the pull request, or why it stopped.
3. When a worker reports, check its result against the ticket. Then `clear` the worker and
   send it the next ticket whose blockers are done.
4. Use `status` to find a worker that is waiting on a prompt or gone. `recycle` one that is stuck.

## Decide yourself

Write each of these decisions, with its reason, into the pull request's description:

- which worker takes which ticket, and when to clear or recycle a worker;
- a choice between ways of doing a ticket that both meet it;
- what to do with a review finding.

## Ask the owner, and wait

- anything that changes what a ticket or the spec asks for;
- merging a pull request;
- permissions, settings, installing software;
- deleting data, publishing anything outside the repository.

## Stay on course

- Hand out only the tickets that exist. Start no new work of your own. A problem outside
  every ticket becomes a note for the owner, not a new task.
- Deliver the tasks the requirements ask for first. A fix that does not affect the core
  function, such as a minor bug, is not a delivery target. List it in the pull request's
  description as an optional fix for after the delivery.
- Run at most <N> worker sessions at a time.
- When a ticket has failed <M> times, stop working on it and ask the owner.
- Stop and report to the owner, instead of working around the problem, when any of these
  happens:
  - every ticket is done;
  - a decision from "Ask the owner" comes up;
  - a worker is stuck again after a `recycle`.
```

## When a session compacts

The plugin does not decide when a session compacts. Two different things compact a conversation.

- **`compact_self`** runs only when the session's model calls it, and the model calls it when its instructions tell it to. The compaction runs when the current turn ends. Afterwards the session is woken: the model is handed `The compaction this session requested with compact_self has finished. This is not an error. Continue the work that was in progress.`, and it carries on from the summary.
- **Claude Code's own automatic compaction**, when the context window fills up, happens as it always does. The plugin neither starts it nor wakes the session after it.

So the timing belongs in the session's instructions, such as your `CLAUDE.md`. An example rule for a session that works through tickets and pull requests:

```markdown
## Compacting the context

When you have the tool `compact_self`, compact your own context with it at these points:

1. After the work has been split into tickets, before the first ticket starts.
2. After the test cases have been planned, before the first test is written.
3. Before the change is handed to an independent review.
4. Before delivery: pushing the branch and opening the pull request.
5. Before a merge.

At points 4 and 5, first look at the size of your context: the input tokens of your latest
model request, uncached, cache-written and cache-read together (Claude Code's status line
gives this as `context_window.total_input_tokens`). Below 200,000 tokens, do not compact;
go on. When you cannot find the size out, compact.

Before compacting:
- commit everything;
- let no background command or subagent run;
- write down what the next step needs and no file holds yet.

Then call `compact_self` as the last step of the turn and end the turn. When you are woken,
reload the skills you use and carry on.

A subagent never calls `compact_self`: it would compact the session that started it.
```

The 200,000-token threshold comes from one user's measurements over 30 days. There, a compaction below that size with 20 to 50 requests still to go cost more than it saved.

## Development

```sh
pnpm install
pnpm verify    # typecheck, lint and tests
```

Two test files run only with `CLAUDE_SESSION_POOL_LIVE=1` set:

- `tests/plugin.live.test.ts` runs Claude Code's plugin validator on the plugin, and needs the `claude` program.
- `tests/terminal.live.test.ts` opens a real Terminal window, and needs Terminal running.

## Documentation

- [docs/specs/claude-session-pool.md](docs/specs/claude-session-pool.md): the behaviour, its boundaries and the facts about Claude Code it rests on.
- [docs/adr/](docs/adr/): the decisions and the options they rejected.
- [docs/CONTEXT.md](docs/CONTEXT.md): the terms used throughout.
