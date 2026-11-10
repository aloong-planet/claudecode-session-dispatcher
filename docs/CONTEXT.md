# claude-session-pool

An MCP server that lets one Claude Code session open, reset, compact and close a set of interactive Claude Code sessions running in Terminal windows on the same Mac. It exists so that a session handing out tickets no longer needs a person to create its worker sessions or to type `/clear` and `/compact` into them.

## Language

**Dispatcher session**:
The Claude Code session that started the server process, and therefore the only caller of its tools. It is never a slot of its own pool.
_Avoid_: main session, lead, master (in Claude Code "lead" names an agent-team role, which this is not)

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
A slash command the server delivers to a worker session by typing it into the session's Terminal tab. It is not a cross-session message: a slash command inside a message arrives as plain text and never runs.
_Avoid_: sent command, injected command
