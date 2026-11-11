# Specs

Each file here describes one feature as it is now: what it does, where its boundaries are, and what it deliberately does not do. A spec is rewritten in place when the feature changes and deleted, together with its row below, when the feature is removed; the history of changes is in git, not in the spec.

A spec states product behaviour, facts about the external systems the feature relies on, persisted formats and architectural constraints. It does not describe how the current code is organised, and it does not cite tickets, branches or working records, which are cleaned up while the spec stays. Decisions and the alternatives they rejected are in `docs/adr/`; a spec refers to an ADR by number.

| Spec | In one line |
|---|---|
| [claude-session-pool](claude-session-pool.md) | An MCP server through which a dispatcher session opens, adopts, clears, compacts, inspects, closes, replaces and releases worker sessions running in Terminal windows. |
