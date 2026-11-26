# claude-session-pool-subagent-watch

## Problem Statement

A session that starts a subagent in the background and ends its turn is woken when the subagent hands back, and by nothing before that. A subagent that stops making progress goes unnoticed for as long as nothing else wakes the session, unless the session wakes itself at an interval to look, and each such wake-up is a model request over the session's whole context.

## Solution

In every interactive session the plugin's mod looks at the session's subagents once a minute, without a model request. When a subagent has made no progress for a set time, the mod starts a turn in the session with a report that names it. The mod ends no subagent.

## User Stories

### claude-session-pool-subagent-watch::US-001 Be told when a subagent of mine is stuck

As a session, I am woken with a report when a subagent of mine stops making progress, so that I neither wake myself to look at it nor leave a stuck subagent unnoticed.

- claude-session-pool-subagent-watch::US-001/AC-01: At every look ([claude-session-pool-plugin::REQ-004](claude-session-pool-plugin.md)) the mod takes the session's subagents as Claude Code lists them, those that a subagent started among them, and judges each one that Claude Code lists as running a turn. No tool starts, pauses or stops this, and no tool chooses the subagents.
- claude-session-pool-subagent-watch::US-001/AC-02: A subagent is stalled at a look when that look and the 11 looks before it all found it running a turn and none of the last 11 found progress in it ([claude-session-pool-plugin::REQ-007/AC-01](claude-session-pool-plugin.md)). It is due for a report at the first look that finds it stalled.
- claude-session-pool-subagent-watch::US-001/AC-03: A stall is reported once ([claude-session-pool-plugin::REQ-006](claude-session-pool-plugin.md)); a stall after the subagent made progress again is a new one. Nothing is reported when a subagent ends or makes progress again.

## Constraints

### claude-session-pool-subagent-watch::CON-001 Subagents are read, never acted on (direct acceptance)

Applies to: the looks and the reports. The mod reads what Claude Code lists of the session's subagents and the sizes of their transcripts. It ends, stops and messages no subagent, and it reports to no session but the one it runs in.

## Failure modes and boundaries

- **A subagent is inside one tool call for as long as a stall takes** ([claude-session-pool-subagent-watch::US-001/AC-02](claude-session-pool-subagent-watch.md)): neither its transcript nor its token count changes meanwhile, so it is reported as stalled.
- **A subagent waits for a permission or for an answer**: it is judged like any other subagent, and the report does not say what it waits for.
- **A subagent waits on work it started itself**, a background command or a subagent of its own: Claude Code lists it as waiting and not as running a turn, so it is not judged and never reported; a subagent it started is judged on its own.
- **A subagent runs for a long time and keeps making progress**: nothing is reported.
- **A subagent runs in the foreground of a turn of the session**: a report waits for that turn to end ([claude-session-pool-plugin::REQ-005/AC-02](claude-session-pool-plugin.md)). The subagent has ended by then, so nothing is reported of it.
- **The mod is loaded again**: a subagent that was reported before can be reported once more for the same stall.
- **Claude Code does not give the list of subagents at a look, or gives something that is not a list**: that look finds no subagent running a turn, so every count starts anew, and nothing is reported of the failure itself. For as long as the list keeps failing, no stall is reported.
- **A subagent's type or description does not pass the form stated under "Text of a report"**: the line leaves that part out.

## Implementation Decisions

### Text of a report

The report's text is the first line below, one line for each subagent that is due, and the last line. `<id>` is the subagent's ID as Claude Code lists it, and `<n>` the count of looks in a row that found no progress. `<about>` is the subagent's type and, in double quotes, its description, separated by a comma and a space; each of the two is put into the text only where it is 1 to 64 characters, each an ASCII letter, a digit, a space, `.`, `_`, `:` or `-`. When neither passes, the brackets are left out with them. An ID that holds any other character than ASCII letters, digits and `-` is written as `a subagent`.

| Part | Text |
|---|---|
| First line | `Report of the subagent watch, written by the cc-session-pool plugin. It is not a message from the user. Subagents of this session that need attention:` |
| Stalled | `- <id> (<about>): running, and neither its transcript nor its token count changed for <n> minutes.` |
| Last line | `Nothing was done to any subagent. Each of these is reported once.` |

### Facts about Claude Code the behaviour rests on

- **The session's subagents.** A mod can ask Claude Code for the session's subagents. Each entry has an ID, the type and the description it was started with, a token count, and a status that tells one running a turn from one that waits on work it started and from one that has ended; an agent-team teammate is marked as such, and a subagent that a subagent started names the one that started it. A subagent that has ended leaves the list within seconds. Measured on Claude Code 2.1.327 for subagents the session started in the background, for one that waits on a subagent it started and for the subagent it started; the mark of a teammate is taken from Claude Code's type definitions for mods and was not measured.
- **A subagent's transcript.** Beside a session's transcript ([claude-session-pool](claude-session-pool.md), "Transcript") Claude Code keeps a directory named after the session ID; a subagent's transcript is the file `agent-<id>.jsonl` in its subdirectory `subagents`. The token count can change while the size of the transcript does not. Measured on Claude Code 2.1.327; Claude Code does not document it as a stable interface. The mod looks for that directory beside the transcript of the session's present conversation, whose path it learns ([claude-session-pool-monitor](claude-session-pool-monitor.md), "What a mod can read"). Where a subagent that was started before a `/clear` keeps its transcript after it has not been measured.
- **During one tool call.** While one tool call of a subagent runs, neither its token count nor the size of its transcript changes. Measured on Claude Code 2.1.327.
- **A subagent that waits for a permission or an answer.** Claude Code lists a subagent that waits for the user to answer a permission prompt as running, and neither its token count nor the size of its transcript changes meanwhile (measured on Claude Code 2.1.327). What it lists for a subagent that waits for the user to answer a question has not been measured: the general-purpose subagent has no tool to ask one (2.1.327).
- **Ending a subagent.** Claude Code's interface for mods has no call that ends or stops a subagent (by its type definitions for mods, 2.1.327).

## Out of Scope

- **Background commands of the session.** A mod cannot list them; a command ends by the time limit it was started with.
- **Ending or stopping a subagent.** What follows a report is decided by the session.
- **A limit on how long a subagent runs.** The time limit that the session set when it started the subagent stays with the session.
- **Agent-team teammates and the agents of a workflow.** Teammates are not judged, and Claude Code does not list a workflow's agents.
