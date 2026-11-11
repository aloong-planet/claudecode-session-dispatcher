import type { SessionEntry } from "./ports.ts";

/** What a tool call comes to: its text, and whether the text is a result or an error. */
export type Outcome = { ok: boolean; text: string };

/** Runs an action and turns what it returns, or the error it throws, into an outcome. */
export async function attempt(action: () => Promise<string>): Promise<Outcome> {
  try {
    return { ok: true, text: await action() };
  } catch (error) {
    return { ok: false, text: messageOf(error) };
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A session's state in words, with what it is waiting for when Claude Code reports that. */
export function describeSession(session: SessionEntry): string {
  if (session.status === "waiting") return session.waitingFor ? `waiting for ${session.waitingFor}` : "waiting";
  return session.status ?? "in an unknown state";
}
