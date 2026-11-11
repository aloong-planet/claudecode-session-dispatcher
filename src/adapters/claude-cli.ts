import type { SessionEntry, SessionLister } from "../ports.ts";
import type { Run } from "./exec.ts";

/** Claude Code's session listing, read with `claude agents --json`. */
export class ClaudeCli implements SessionLister {
  private readonly run: Run;

  constructor(run: Run) {
    this.run = run;
  }

  async list(): Promise<SessionEntry[]> {
    const text = await this.run("claude", ["agents", "--json"]);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("`claude agents --json` did not print JSON, so the sessions on this Mac could not be listed.");
    }
    if (!Array.isArray(data)) throw new Error("`claude agents --json` did not print a list of sessions.");
    return data.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const { kind, cwd, pid, name, sessionId, status, waitingFor } = item as Record<string, unknown>;
      if (typeof kind !== "string" || typeof cwd !== "string") return [];
      return [
        {
          kind,
          cwd,
          pid: typeof pid === "number" ? pid : undefined,
          name: typeof name === "string" ? name : undefined,
          sessionId: typeof sessionId === "string" ? sessionId : undefined,
          status: typeof status === "string" ? status : undefined,
          waitingFor: typeof waitingFor === "string" ? waitingFor : undefined,
        },
      ];
    });
  }
}
