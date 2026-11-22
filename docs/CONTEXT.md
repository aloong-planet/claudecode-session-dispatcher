# claude-session-pool

A Claude Code plugin whose MCP server lets one Claude Code session open, reset, compact and close a set of interactive Claude Code sessions running in Terminal windows on the same Mac, and offers every session that loads it a tool with which that session compacts its own conversation; the plugin's mod, or where it does not run a hook of the plugin, wakes that session afterwards. Where the plugin's mod runs and Claude Code accepts the mod's tool, the plugin also offers every session a tool that reports the size of its own context. It exists so that a session handing out tickets no longer needs a person to create its worker sessions or to type `/clear` and `/compact` into them.

## Language

**Dispatcher session**:
The Claude Code session that the start-up command started, and the only one the server offers a pool's tools to. It is never a slot of its own pool.
_Avoid_: main session, lead, master (in Claude Code "lead" names an agent-team role, which this is not)

**Attached session**:
The Claude Code session that started a given server process. Every session that loads the server has a process of its own, so an attached session is a dispatcher session only when the start-up command started it.
_Avoid_: caller, own session, current session

**Worker session**:
An interactive Claude Code session running in a Terminal window that occupies a slot. It is not a background session started with `claude --bg`, a subagent or an agent-team teammate.
_Avoid_: agent, teammate, pool session

**Slot**:
A name in a pool that successive worker sessions answer to. A slot is the name, not the process or the conversation: after a clear the same slot holds a new conversation, and after a recycle a new process.
_Avoid_: member, seat

**Pool**:
The slots registered for one directory. A session started in that directory is not in the pool until the server opens it or adopts it.
_Avoid_: fleet, team

**Roster**:
The persisted list of a pool's slots.
_Avoid_: registry, session table

**Typed command**:
A slash command the server delivers to a worker session by typing it into the session's Terminal tab, after an interrupt that discards the input box. It is not a cross-session message: a slash command inside a message arrives as plain text and never runs. The `/compact` that `compact_self` types into the attached session's tab, without the interrupt, is not a typed command.
_Avoid_: sent command, injected command

**Clear order**:
What the server leaves for a worker session so that the plugin's mod, running in that session, runs `/clear` itself instead of the server typing it. It names the conversation to clear by its session ID, so it does not apply to the conversation that the clear starts; it is neither a typed command nor a wake request.
_Avoid_: clear request (a wake request is the other thing the server leaves), clear message (it is not a cross-session message)

**Wake request**:
What a `compact_self` call that the server handles leaves for a conversation so that the plugin's hook wakes the session when that conversation's next compaction, started by `/compact` or asked for by the plugin's mod, has finished. It belongs to the conversation, not to the session's process: after a clear the session holds another conversation, and the request does not apply to it.
_Avoid_: follow-up, pending compaction

**Hook record**:
What the plugin's hook leaves at every session start, by which the server knows that the plugin's hooks run in that session. It is not an entry in the session's transcript and not the declaration that makes Claude Code run the hook.
_Avoid_: marker, hook log

**Mod**:
The plugin's hooks module: code of the plugin that Claude Code loads into a session's own process. It is not one of the plugin's hooks, which are commands that Claude Code starts as separate processes.
_Avoid_: hook module, extension, in-process hook
