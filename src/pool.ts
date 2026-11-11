import { realpathSync } from "node:fs";
import type { Clock, Processes, SessionEntry, SessionLister, TabRef, Terminal, TranscriptMark, Transcripts } from "./ports.ts";
import { RosterStore, type Slot } from "./roster.ts";
import { Refusal, checkModel, checkPermissionMode, checkSlotName, checkTimeoutMinutes } from "./validate.ts";

export type Outcome = { ok: boolean; text: string };

export type PoolDeps = {
  /** The pool directory: where the dispatcher session was started. */
  directory: string;
  /** The process ID of the dispatcher session, which no tool may act on. */
  dispatcherPid: number;
  /** The directory that holds the roster files of every pool. */
  rosterRoot: string;
  sessions: SessionLister;
  terminal: Terminal;
  processes: Processes;
  transcripts: Transcripts;
  clock: Clock;
};

export const LIMITS = {
  pollMs: 1000,
  compactPollMs: 2000,
  idleBeforeTypingMs: 60_000,
  openReadyMs: 60_000,
  clearConfirmMs: 30_000,
  compactStartMs: 20_000,
  compactRecordAfterIdleMs: 10_000,
  compactDefaultMinutes: 30,
  exitMs: 15_000,
};

const DEFAULT_MODEL = "opus";
const DEFAULT_PERMISSION_MODE = "auto";

type LiveSession = SessionEntry & { pid: number };

type Resolved =
  | { state: "gone" }
  | { state: "ambiguous"; count: number }
  | { state: "live"; session: LiveSession };

/** What a wait saw on one poll: the slot's state, or nothing because the sessions could not be listed. */
type Observed = Resolved | { state: "unknown"; error: string };

type OpenArgs = { name: string; model?: string; permissionMode?: string };

/** The slots registered for one directory, and the operations a dispatcher session performs on them. */
export class Pool {
  private readonly deps: PoolDeps;
  private readonly directory: string;
  private readonly roster: RosterStore;
  private readonly opening = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: PoolDeps) {
    this.deps = deps;
    this.directory = canonical(deps.directory);
    this.roster = new RosterStore(deps.rosterRoot, this.directory);
  }

  open(args: OpenArgs): Promise<Outcome> {
    return attempt(() => this.openSlot(args));
  }

  async init(args: { names: string[]; model?: string; permissionMode?: string }): Promise<Outcome> {
    if (args.names.length === 0) return { ok: false, text: "init needs at least one slot name." };
    const lines: string[] = [];
    let ok = true;
    for (const name of args.names) {
      const outcome = await this.open({ name, model: args.model, permissionMode: args.permissionMode });
      ok &&= outcome.ok;
      lines.push(`${name}: ${outcome.ok ? "opened" : "failed"}. ${outcome.text}`);
    }
    return { ok, text: lines.join("\n") };
  }

  adopt(args: { name: string }): Promise<Outcome> {
    return attempt(() => this.adoptSlot(args.name));
  }

  status(): Promise<Outcome> {
    return attempt(async () => {
      const slots = this.roster.read();
      if (slots.length === 0) return "The roster has no slots.";
      const sessions = await this.deps.sessions.list();
      return slots.map((slot) => `${slot.name}: ${this.describeResolved(this.resolveIn(sessions, slot.name))}`).join("\n");
    });
  }

  clear(args: { name: string }): Promise<Outcome> {
    return attempt(() => this.clearSlot(args.name));
  }

  compact(args: { name: string; timeoutMinutes?: number }): Promise<Outcome> {
    return attempt(() => this.compactSlot(args.name, args.timeoutMinutes ?? LIMITS.compactDefaultMinutes));
  }

  close(args: { name: string; force?: boolean }): Promise<Outcome> {
    return attempt(() => this.closeSlot(args.name, args.force ?? false, false));
  }

  recycle(args: OpenArgs & { force?: boolean }): Promise<Outcome> {
    return attempt(async () => {
      checkSlotName(args.name);
      checkModel(args.model ?? DEFAULT_MODEL);
      checkPermissionMode(args.permissionMode ?? DEFAULT_PERMISSION_MODE);
      const closed = await this.closeSlot(args.name, args.force ?? false, true);
      try {
        return `${closed}\n${await this.openSlot(args, true)}`;
      } catch (error) {
        const state = this.describeObserved(await this.observe(args.name));
        throw new Refusal(
          `${closed}\nNo new session was confirmed: ${messageOf(error)}\nThe slot "${args.name}" stays in the roster and is now ${state}.`,
        );
      }
    });
  }

  release(args: { name: string }): Promise<Outcome> {
    return attempt(async () => {
      checkSlotName(args.name);
      this.requireSlot(args.name);
      await this.removeSlot(args.name);
      return `Released "${args.name}": it was removed from the roster. Its session was not touched.`;
    });
  }

  private async openSlot(
    { name, model = DEFAULT_MODEL, permissionMode = DEFAULT_PERMISSION_MODE }: OpenArgs,
    recycling = false,
  ): Promise<string> {
    checkSlotName(name);
    checkModel(model);
    checkPermissionMode(permissionMode);
    // A name that is already a slot stays in the roster whatever happens next.
    const keepsSlot = recycling || this.roster.read().some((slot) => slot.name === name);
    if (this.opening.has(name)) throw new Refusal(`Another call is already opening "${name}"; nothing was opened.`);
    this.opening.add(name);
    try {
      const taken = (await this.deps.sessions.list()).find((session) => session.pid !== undefined && session.name === name);
      if (taken) {
        throw new Refusal(`A live session already answers to "${name}" (pid ${taken.pid}, in ${taken.cwd}); nothing was opened.`);
      }
      const { windowId } = await this.exclusive(() =>
        this.deps.terminal.open({
          directory: this.directory,
          argv: ["claude", "-n", name, "--model", model, "--permission-mode", permissionMode],
        }),
      );
      const deadline = this.deps.clock.now() + LIMITS.openReadyMs;
      let seen: Observed;
      for (;;) {
        seen = await this.observe(name);
        if (seen.state === "live" && seen.session.status === "idle") {
          await this.recordOpened(name, seen.session.pid);
          return `Opened "${name}": idle, session ${seen.session.sessionId}.`;
        }
        if (this.deps.clock.now() >= deadline) break;
        await this.deps.clock.sleep(LIMITS.pollMs);
      }
      // A slot that stays in the roster must record the session just opened for it, or forget the one it recorded.
      if (keepsSlot) await this.recordOpened(name, seen.state === "live" ? seen.session.pid : undefined);
      const visible = await this.deps.terminal
        .lastLines(windowId)
        .catch((error: unknown) => `(the window's contents could not be read: ${messageOf(error)})`);
      const kept = recycling
        ? "Its window was left open."
        : keepsSlot
          ? `Its window was left open. "${name}" stays in the roster.`
          : `Its window was left open and "${name}" was not added to the roster.`;
      const listing = seen.state === "unknown" ? ` The sessions could not be listed: ${seen.error}` : "";
      throw new Refusal(
        `A window was opened for "${name}", but its session was not idle after ${LIMITS.openReadyMs / 1000} seconds. ${kept}${listing} The window shows:\n${quoted(visible)}`,
      );
    } finally {
      this.opening.delete(name);
    }
  }

  private async adoptSlot(name: string): Promise<string> {
    checkSlotName(name);
    if (this.roster.read().some((slot) => slot.name === name)) return `"${name}" is already a slot; nothing changed.`;
    const named = (await this.deps.sessions.list()).filter(
      (session): session is LiveSession => session.kind === "interactive" && session.pid !== undefined && session.name === name,
    );
    const here = named.filter((session) => canonical(session.cwd) === this.directory);
    if (here.length === 0) {
      throw new Refusal(
        named[0]
          ? `The session named "${name}" runs in ${named[0].cwd}, not in this pool's directory ${this.directory}; it was not adopted.`
          : `No live interactive session answers to "${name}"; nothing was adopted.`,
      );
    }
    if (here.length > 1) {
      throw new Refusal(`${here.length} sessions in this pool's directory answer to "${name}"; none was adopted.`);
    }
    const session = here[0]!;
    if (session.pid === this.deps.dispatcherPid) {
      throw new Refusal(`"${name}" is the dispatcher session itself and cannot be a slot.`);
    }
    if (!(await this.findTab(session.pid))) {
      throw new Refusal(`The session "${name}" (pid ${session.pid}) does not run in a Terminal window; it was not adopted.`);
    }
    await this.updateRoster((slots) => (slots.some((slot) => slot.name === name) ? slots : [...slots, { name, origin: "adopted" }]));
    return `Adopted "${name}": ${describeSession(session)}, session ${session.sessionId}.`;
  }

  private async clearSlot(name: string): Promise<string> {
    const before = await this.typeInto(name, "/clear");
    const typed = `"/clear" was typed into the slot "${name}"`;
    const deadline = this.deps.clock.now() + LIMITS.clearConfirmMs;
    for (;;) {
      await this.deps.clock.sleep(LIMITS.pollMs);
      const seen = await this.observe(name);
      if (seen.state === "live" && seen.session.pid === before.pid && seen.session.sessionId !== before.sessionId) {
        return `Cleared "${name}": session ${before.sessionId} was replaced by session ${seen.session.sessionId}.`;
      }
      if (this.sessionReplaced(seen, before)) {
        throw new Refusal(`${typed}, and the slot is now ${this.describeReplaced(seen, before)}: not confirmed.`);
      }
      if (this.deps.clock.now() >= deadline) {
        const observed =
          seen.state === "unknown" ? `the sessions could not be listed (${seen.error})` : `its session ID was still ${before.sessionId}`;
        throw new Refusal(
          `${typed}, but ${observed} after ${LIMITS.clearConfirmMs / 1000} seconds: not confirmed. The command was not typed again.`,
        );
      }
    }
  }

  private async compactSlot(name: string, timeoutMinutes: number): Promise<string> {
    checkTimeoutMinutes(timeoutMinutes);
    let mark: TranscriptMark | undefined;
    const before = await this.typeInto(name, "/compact", (session) => {
      mark = session.sessionId === undefined ? undefined : this.deps.transcripts.mark(session.sessionId);
    });
    const typed = `"/compact" was typed into the slot "${name}"`;
    if (!mark) {
      throw new Refusal(
        `unconfirmed: ${typed}, but the transcript of session ${before.sessionId} could not be found or read, so the compaction cannot be confirmed.`,
      );
    }
    const typedAt = this.deps.clock.now();
    const deadline = typedAt + timeoutMinutes * 60_000;
    let sawBusy = false;
    let idleSince: number | undefined;
    for (;;) {
      await this.deps.clock.sleep(LIMITS.compactPollMs);
      if (this.deps.transcripts.compactedSince(mark)) {
        return `Compacted "${name}": the transcript of session ${before.sessionId} records a compaction that finished after the command was typed.`;
      }
      const now = this.deps.clock.now();
      const seen = await this.observe(name);
      if (this.sessionReplaced(seen, before)) {
        throw new Refusal(`unconfirmed: ${typed}, and the slot is now ${this.describeReplaced(seen, before)}.`);
      }
      if (seen.state !== "live") {
        // The state is not known on this poll, so neither early-return rule applies; only the time limit does.
      } else if (seen.session.status !== "idle") {
        sawBusy = true;
        idleSince = undefined;
      } else if (sawBusy) {
        idleSince ??= now;
        if (now - idleSince >= LIMITS.compactRecordAfterIdleMs) {
          throw new Refusal(
            `unconfirmed: ${typed}; the session became busy and returned to idle, and its transcript records no compaction ${LIMITS.compactRecordAfterIdleMs / 1000} seconds later.`,
          );
        }
      } else if (now - typedAt >= LIMITS.compactStartMs) {
        throw new Refusal(
          `unconfirmed: ${typed}, but the session had not become busy ${LIMITS.compactStartMs / 1000} seconds later, so the command seems to have had no effect.`,
        );
      }
      if (now >= deadline) {
        const listing = seen.state === "unknown" ? ` The sessions could not be listed: ${seen.error}` : "";
        throw new Refusal(
          `unconfirmed: ${typed}, and its transcript records no compaction after ${timeoutMinutes} minutes. The command was not typed again.${listing}`,
        );
      }
    }
  }

  private async closeSlot(name: string, force: boolean, keepSlot: boolean): Promise<string> {
    checkSlotName(name);
    const slot = this.requireSlot(name);
    const resolved = await this.resolve(name);
    if (resolved.state === "ambiguous") {
      throw new Refusal(`${resolved.count} sessions answer to the slot "${name}"; none was ended.`);
    }
    if (resolved.state === "gone") {
      if (!keepSlot) await this.removeSlot(name);
      return `No live session answered to "${name}"${keepSlot ? "." : "; it was removed from the roster."}`;
    }
    const session = resolved.session;
    this.refuseDispatcher(session, name, "it was not closed");
    if (session.status !== "idle" && !force) {
      throw new Refusal(`The slot "${name}" is ${describeSession(session)}; it was not closed. Pass force to close it anyway.`);
    }
    // The server closes only a window it opened itself: the one that hosts the session it opened for this slot.
    const serverOpened = slot.origin === "opened" && slot.pid === session.pid;
    const tab = serverOpened ? await this.findTab(session.pid) : undefined;
    this.deps.processes.terminate(session.pid);
    const deadline = this.deps.clock.now() + LIMITS.exitMs;
    while (this.deps.processes.isAlive(session.pid)) {
      if (this.deps.clock.now() >= deadline) {
        throw new Refusal(
          `The session of the slot "${name}" (pid ${session.pid}) had not exited ${LIMITS.exitMs / 1000} seconds after it was asked to end. The slot stays in the roster and no window was closed.`,
        );
      }
      await this.deps.clock.sleep(LIMITS.pollMs);
    }
    const ended = `Closed "${name}": its session (pid ${session.pid}) ended.`;
    if (!keepSlot) {
      try {
        await this.removeSlot(name);
      } catch (error) {
        throw new Refusal(`${ended} The roster could not be updated, so the slot is still listed: ${messageOf(error)}`);
      }
    }
    if (!serverOpened) {
      return `${ended} Its Terminal window was left open, because the roster does not record this session as one the server opened.`;
    }
    if (!tab) return `${ended} No Terminal window was found for it.`;
    if (tab.tabCount > 1) return `${ended} Its tab was left open, because its window has other tabs and Terminal cannot close a single tab.`;
    try {
      await this.exclusive(() => this.deps.terminal.close(tab.windowId));
    } catch (error) {
      throw new Refusal(`${ended} Its Terminal window could not be closed: ${messageOf(error)}`);
    }
    return `${ended} Its Terminal window was closed.`;
  }

  /** Types a command into an idle slot's Terminal tab and returns the session as it was just before. */
  private async typeInto(name: string, command: string, beforeTyping?: (session: LiveSession) => void): Promise<LiveSession> {
    checkSlotName(name);
    this.requireSlot(name);
    const deadline = this.deps.clock.now() + LIMITS.idleBeforeTypingMs;
    let session: LiveSession;
    for (;;) {
      const resolved = await this.resolve(name);
      if (resolved.state !== "live") {
        throw new Refusal(`The slot "${name}" is ${this.describeResolved(resolved)}; nothing was typed.`);
      }
      this.refuseDispatcher(resolved.session, name, "nothing was typed");
      if (resolved.session.status === "idle") {
        session = resolved.session;
        break;
      }
      if (this.deps.clock.now() >= deadline) {
        throw new Refusal(
          `The slot "${name}" is ${describeSession(resolved.session)} and did not become idle within ${LIMITS.idleBeforeTypingMs / 1000} seconds; nothing was typed.`,
        );
      }
      await this.deps.clock.sleep(LIMITS.pollMs);
    }
    const tab = await this.findTab(session.pid);
    if (!tab) {
      throw new Refusal(`No Terminal tab hosts the slot "${name}" (pid ${session.pid}); nothing was typed.`);
    }
    beforeTyping?.(session);
    await this.exclusive(() => this.deps.terminal.typeCommand(tab, command));
    return session;
  }

  private refuseDispatcher(session: LiveSession, name: string, consequence: string): void {
    if (session.pid === this.deps.dispatcherPid) {
      throw new Refusal(`The slot "${name}" is answered by the dispatcher session itself; ${consequence}.`);
    }
  }

  private requireSlot(name: string): Slot {
    const slot = this.roster.read().find((candidate) => candidate.name === name);
    if (!slot) throw new Refusal(`"${name}" is not a slot in this pool's roster; nothing was done.`);
    return slot;
  }

  /** Records the session opened for a slot. A failure here follows an opened window, so the error says so. */
  private async recordOpened(name: string, pid: number | undefined): Promise<void> {
    try {
      await this.registerOpened(name, pid);
    } catch (error) {
      throw new Refusal(`A window was opened for "${name}", but the roster could not be updated: ${messageOf(error)}`);
    }
  }

  /** Whether the session a command was typed into is no longer the one, and the only one, that answers to the name. */
  private sessionReplaced(seen: Observed, before: LiveSession): boolean {
    return seen.state === "gone" || seen.state === "ambiguous" || (seen.state === "live" && seen.session.pid !== before.pid);
  }

  private describeReplaced(seen: Observed, before: LiveSession): string {
    const state = this.describeObserved(seen);
    return seen.state === "live" && seen.session.pid !== before.pid
      ? `${state}, in another process (pid ${seen.session.pid}, not ${before.pid})`
      : state;
  }

  private registerOpened(name: string, pid: number | undefined): Promise<void> {
    const slot: Slot = pid === undefined ? { name, origin: "opened" } : { name, origin: "opened", pid };
    return this.updateRoster((slots) => [...slots.filter((candidate) => candidate.name !== name), slot]);
  }

  private removeSlot(name: string): Promise<void> {
    return this.updateRoster((slots) => slots.filter((slot) => slot.name !== name));
  }

  private updateRoster(change: (slots: Slot[]) => Slot[]): Promise<void> {
    return this.exclusive(() => {
      this.roster.write(change(this.roster.read()));
    });
  }

  private async findTab(pid: number): Promise<TabRef | undefined> {
    const tty = await this.deps.processes.ttyOf(pid);
    return tty === undefined ? undefined : this.deps.terminal.findTab(tty);
  }

  private async resolve(name: string): Promise<Resolved> {
    return this.resolveIn(await this.deps.sessions.list(), name);
  }

  /** The slot's state during a wait. A listing that fails is reported as "unknown", so that the wait can go on. */
  private async observe(name: string): Promise<Observed> {
    try {
      return await this.resolve(name);
    } catch (error) {
      return { state: "unknown", error: messageOf(error) };
    }
  }

  private describeObserved(observed: Observed): string {
    return observed.state === "unknown" ? `in an unknown state (${observed.error})` : this.describeResolved(observed);
  }

  private resolveIn(sessions: SessionEntry[], name: string): Resolved {
    const matches = sessions.filter(
      (session): session is LiveSession =>
        session.kind === "interactive" && session.pid !== undefined && session.name === name && canonical(session.cwd) === this.directory,
    );
    if (matches.length === 0) return { state: "gone" };
    if (matches.length > 1) return { state: "ambiguous", count: matches.length };
    return { state: "live", session: matches[0]! };
  }

  private describeResolved(resolved: Resolved): string {
    if (resolved.state === "gone") return "gone";
    if (resolved.state === "ambiguous") return `ambiguous, ${resolved.count} sessions answer to this name`;
    return `${describeSession(resolved.session)}, session ${resolved.session.sessionId}`;
  }

  /** Runs one step at a time, so that two calls never interleave keystrokes or lose a roster update. */
  private exclusive<T>(step: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(step, step);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function describeSession(session: SessionEntry): string {
  if (session.status === "waiting") return session.waitingFor ? `waiting for ${session.waitingFor}` : "waiting";
  return session.status ?? "in an unknown state";
}

async function attempt(action: () => Promise<string>): Promise<Outcome> {
  try {
    return { ok: true, text: await action() };
  } catch (error) {
    return { ok: false, text: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** A directory path with symbolic links resolved, so that two spellings of one directory compare equal. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
