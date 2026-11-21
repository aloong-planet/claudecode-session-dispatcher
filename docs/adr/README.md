# Architecture decision records

Each record states one decision that is in force in this project, with the options it rejected. It does not tell the history of the decision, which git keeps.

- **When to write one.** Only when all three hold: the decision is hard to reverse, a later reader would not understand it without the context, and it came from a real trade-off between alternatives. Even then, a record holds only this project's architectural decisions, the trade-offs behind a product behaviour or a calculation, and this project's choice among ways of working. A rule for people who change code goes to the project's `AGENTS.md`, the statement of a behaviour to its spec, an incident to a post-mortem, and how code implements a decision to a comment in that code.
- **Sections.** Every record has all five. Context holds the problem and the constraints on it, in at most 3 sentences. Options holds one item per option, the chosen one first, in at most 2 sentences each; an option that was not compared at the time is marked "(not recorded)" and is given no invented comparison. Decision holds the rule in force. Consequences holds the positive, negative and neutral effects that still hold, in at most 2 sentences each. Sources holds pointers to the evidence and the key numbers with the premises they hold under.
- **What no section holds.** How the rule was proposed or found needed; how it was verified or put into place; one-off costs already paid; how the code implements it, and interface detail; how a measurement was taken; line numbers and lists of places; what another record, a spec or a skill already says, for which a pointer is enough; options about how the decision is recorded.
- **Length.** At most 5,000 characters apart from the title and the status line.
- **Status.** `Proposed`: the direction is chosen and the evidence is not complete. `Accepted (date)`: the evidence is complete, and the date is the one on which the owner confirmed the decision in force.
- **Changing a record.** A record states only the decision in force; when the decision changes, the record is changed and no new one is opened to replace it. A change to what a record chose, rejected or accepts needs the owner's confirmation and moves its date; a rewrite that changes no decision does not. A new decision goes into the existing record whose Decision it makes untrue, and only when there is none is a new record opened.
- **Numbering.** Files are `NNNN-slug.md`, numbered in order; a number is never reused. A record that is merged into another, or whose decision is withdrawn, loses its number: its file is deleted, every reference to it is pointed to the record it merged into or removed, and the number is listed under "Retired numbers" with that record's number or "Withdrawn".

| # | Decision | Status |
|---|---|---|
| [0001](0001-interactive-terminal-worker-sessions.md) | Worker sessions are interactive sessions in Terminal windows | Accepted (2026-11-11) |
| [0002](0002-wake-by-hook-plugin-delivery.md) | A session that compacts itself is woken by the plugin's mod, or by a hook where the mod does not run; the server, the hooks and the mod are one plugin | Proposed |
| [0003](0003-clear-through-a-clear-order-the-mod-acts-on.md) | A worker session is cleared through a clear order that the plugin's mod acts on, and by typing only where the plugin does not run | Proposed |
