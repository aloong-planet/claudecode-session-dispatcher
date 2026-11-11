# Architecture decision records

Each record states one architectural decision of this project and the options it rejected.

- **Template.** Every record has all five sections: Context, Options, Decision, Consequences, Sources. Options lists the rejected alternatives with the reason for each; an alternative that was not compared at the time is marked "(not recorded)" and is not given an invented comparison. Consequences lists positive, negative and neutral effects.
- **Status.** `Proposed`: the direction is chosen and the evidence is not complete; the record may be rewritten. `Accepted (date)`: the evidence is complete; the record is only appended to. To overturn an accepted record, write a new one and mark the old one `Superseded by ADR-XXXX`.
- **What belongs here.** Only this project's architectural decisions. Process, workflow and document-format conventions do not.
- **When to write one.** Only when all three hold: the decision is hard to reverse, a later reader would not understand it without the context, and it came from a real trade-off between alternatives.
- **Numbering.** Files are `NNNN-slug.md`, numbered in order; a number is never reused.

| # | Decision | Status |
|---|---|---|
| [0001](0001-interactive-terminal-worker-sessions.md) | Worker sessions are interactive sessions in Terminal windows | Accepted (2026-11-11) |
| [0002](0002-wake-by-hook-plugin-delivery.md) | A hook wakes a session after it compacts itself; the server and the hooks are one plugin | Proposed |
