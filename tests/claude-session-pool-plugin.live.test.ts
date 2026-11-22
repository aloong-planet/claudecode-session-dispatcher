/**
 * The plugin against Claude Code's own validator, which reads the manifest, the hooks file and the mod's source the
 * way Claude Code does when it loads them. It needs the `claude` program, so it runs only when
 * CLAUDE_SESSION_POOL_LIVE=1 is set. No session is started.
 *
 * The validator holds a mod to rules that neither the compiler nor the other tests know: for one, the engine's
 * interface may be passed only to functions declared at the top of the module.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDirectory = join(dirname(dirname(fileURLToPath(import.meta.url))), "plugin");

describe.skipIf(process.env.CLAUDE_SESSION_POOL_LIVE !== "1")("the plugin, live", () => {
  it("passes Claude Code's validator, which names the hooks the mod adds", () => {
    const validated = spawnSync("claude", ["plugin", "validate", pluginDirectory], { encoding: "utf8", timeout: 60_000 });

    expect(validated.stdout).toContain("./register.ts hooks: classic.SessionStart, classic.FileChanged, session.start, tool.call, turn.start, turn.complete");
    expect(validated.stdout).toContain("Validation passed");
    expect(validated.status).toBe(0);
  });
});
