import { parseSessionListing } from "../../plugin/hooks/pool-rule.ts";
import type { InstalledPlugin, PluginLister, SessionEntry, SessionLister } from "../ports.ts";
import type { Run } from "./exec.ts";

/** Claude Code's session listing, read with `claude agents --json`, and its plugin listing, read with `claude plugin list --json`. */
export class ClaudeCli implements SessionLister, PluginLister {
  private readonly run: Run;

  constructor(run: Run) {
    this.run = run;
  }

  async list(): Promise<SessionEntry[]> {
    return parseSessionListing(await this.run("claude", ["agents", "--json"]));
  }

  async installed(): Promise<InstalledPlugin[]> {
    const text = await this.run("claude", ["plugin", "list", "--json"]);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("`claude plugin list --json` did not print JSON");
    }
    if (!Array.isArray(data)) throw new Error("`claude plugin list --json` did not print a list of plugins");
    return data.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const { id, enabled, readFromFolder } = item as Record<string, unknown>;
      if (typeof id !== "string") return [];
      return [{ id, enabled, readFromFolder: typeof readFromFolder === "string" ? readFromFolder : undefined }];
    });
  }
}
