/**
 * The state directory of the plugin's hook program, a temporary directory here, and the hook as it runs in a session
 * process: a function of the event Claude Code describes to it and of the files under the state directory. Hook records
 * and wake requests are made the way the product makes them: by the hook on `SessionStart` and by `WakeState`, which
 * `compact_self` uses.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "../../src/hooks.ts";
import { WakeState } from "../../src/wake.ts";
import { temporaryDirectory } from "./temporary.ts";

export const QUIET = { exitCode: 0, stderr: "" };

/** A state directory, and the hook as it runs in the session process `pid` while the processes in `alive` run. */
export function hookSetup(alive: number[] = [4242]) {
  const home = temporaryDirectory();
  const root = join(home, "state");
  const state = new WakeState(root);
  const hook = (input: unknown, pid = 4242) => runHook(input, { state, sessionPid: pid, isAlive: (candidate) => alive.includes(candidate) });
  const started = (sessionId: string, pid = 4242, source = "startup") => hook({ hook_event_name: "SessionStart", session_id: sessionId, source }, pid);
  const compacted = (sessionId: string, trigger = "manual") => hook({ hook_event_name: "PostCompact", session_id: sessionId, trigger, compact_summary: "…" });
  const files = (kind: "hooks" | "wake-requests") => (existsSync(join(root, kind)) ? readdirSync(join(root, kind)).sort() : []);
  const read = (kind: "hooks" | "wake-requests", name: string) => JSON.parse(readFileSync(join(root, kind, name), "utf8")) as unknown;
  return { root, state, hook, started, compacted, files, read };
}
