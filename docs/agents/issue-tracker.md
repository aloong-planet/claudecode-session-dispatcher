# Issue tracker: local files

Tickets in this repository are files. They do not go to any remote tracker.

## Conventions

- One directory per feature: `docs/.workings/<slug>/`
- A ticket is `docs/.workings/<slug>/issues/<NN>-<slug>.md`, numbered from `01` in dependency order (blockers first)
- **One file per ticket; tickets must not be merged into a single file**
- Dependencies go in a `Blocked by: NN, NN` line near the top of the file; a ticket is unblocked only when the changes of every ticket listed there are in the default branch
- Status goes in a `Status:` line near the top; a ticket an agent may take is marked `ready-for-agent`
- Discussion and additions are appended under the `## Comments` heading at the end of the file

## The spec is not here

**A spec is a conclusion and is maintained long-term at `docs/specs/<slug>.md`**, not under `docs/.workings/`. `docs/.workings/` holds only process: tickets and the other working records. The layout and its reasons are in `docs/agents/docs-layout.md`.

## When a skill says "publish to the issue tracker"

Create a new file under `docs/.workings/<slug>/issues/` (create the directory if it does not exist).

## When a skill says "fetch the relevant ticket"

Read the path that was referenced. The user usually gives the path or the number directly.
