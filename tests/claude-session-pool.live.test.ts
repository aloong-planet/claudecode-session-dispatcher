/**
 * The mod's own tool in a real Claude Code session: `claude -p` with the plugin loaded from this checkout. It needs the
 * `claude` program and a login, and makes a few model requests on the smallest model, so it runs only when
 * CLAUDE_SESSION_POOL_LIVE=1 is set. The session is not interactive, keeps no transcript and runs in an empty
 * temporary directory, under the person's own Claude Code configuration, in which `--plugin-dir` takes the place of an
 * installed copy of the plugin.
 *
 * Not covered here:
 * - The figures in an interactive session: no test drives one. They were measured by hand on Claude Code 2.1.322.
 * - Other tool calls made in the same response as `context_usage`: whether the model puts several calls in one
 *   response is its own choice, so no prompt brings it about reliably.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDirectory = join(dirname(dirname(fileURLToPath(import.meta.url))), "plugin");
const TOOL = "mcp__cc-session-pool__context_usage";

/** The parts of Claude Code's `stream-json` events that the test reads, as Claude Code 2.1.322 writes them. */
type Usage = { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
type Block = { type: string; name?: string; id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
type StreamEvent = { type: string; subtype?: string; tools?: string[]; message?: { content?: Block[]; usage?: Usage } };

describe.skipIf(process.env.CLAUDE_SESSION_POOL_LIVE !== "1")("the tool context_usage, live", () => {
  it("is in the tool list of a session that is not interactive, once, and answers each call with the input of the request that made it", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
    try {
      const prompt = `Call the tool ${TOOL} once. Then reply with its output, verbatim, and nothing else.`;
      const session = spawnSync(
        "claude",
        ["-p", prompt, "--plugin-dir", pluginDirectory, "--model", "haiku", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--allowedTools", TOOL],
        { cwd: directory, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024 },
      );
      expect(session.status).toBe(0);
      const events = session.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as StreamEvent);

      const init = events.find((event) => event.type === "system" && event.subtype === "init");
      expect(init?.tools?.filter((tool) => tool === TOOL)).toEqual([TOOL]);

      const results = events.flatMap((event) => (event.type === "user" ? (event.message?.content ?? []) : [])).filter((block) => block.type === "tool_result");
      const calls = events.flatMap((event) =>
        event.type === "assistant"
          ? (event.message?.content ?? []).filter((block) => block.type === "tool_use" && block.name === TOOL).map((block) => ({ id: block.id, usage: event.message!.usage! }))
          : [],
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const { id, usage } of calls) {
        const result = results.find((block) => block.tool_use_id === id);
        expect(result?.is_error).not.toBe(true);
        const figures = /^Context: (\d+) input tokens of a (\d+)-token window \((\d+)%\)\. /.exec(String(result?.content));
        expect(figures).not.toBeNull();
        const [tokens, window, percent] = figures!.slice(1).map(Number) as [number, number, number];
        expect(tokens).toBe(usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens);
        expect(window).toBeGreaterThan(tokens);
        expect(percent).toBe(Math.round((tokens / window) * 100));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 200_000);
});
