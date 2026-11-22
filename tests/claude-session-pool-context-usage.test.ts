/**
 * The tool `context_usage` that the plugin's mod offers, through the one thing the mod exports: `register`, which Claude
 * Code calls with the function that adds hooks. Claude Code's side is the fake engine of `support/mod-engine.ts`, in
 * which a test decides which context figures Claude Code has.
 *
 * Not covered here, because it needs a real Claude Code session: that Claude Code lists the mod's own tool and gives
 * it the figures of the calling request. That is checked live in `claude-session-pool-context-usage.live.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FROM_SERVER, MEASURED, REGISTRATION_REFUSED, USAGE_TOOL, modSetup } from "./support/mod-engine.ts";
import { cleanUpTemporaryDirectories } from "./support/temporary.ts";

afterEach(cleanUpTemporaryDirectories);

describe("the tool context_usage", () => {
  it.each([
    { what: "an interactive session", interactive: true },
    { what: "a session that is not interactive", interactive: false },
  ])("is offered from the start of $what, with its definition in the tool list and no arguments", async ({ interactive }) => {
    const { tools } = await modSetup({ interactive });

    expect(tools).toEqual([
      { name: "context_usage", description: expect.stringMatching(/context/) as unknown, inputSchema: { type: "object", properties: {} }, isDeferred: false },
    ]);
  });

  it("is missing when Claude Code refuses to register it, which leaves Claude Code's reason in its debug log alone, and the mod still answers compact_self", async () => {
    const { calls, tools, logs } = await modSetup({ registerFails: true });

    const answered = (await calls()) as { result?: string; deny?: string };

    expect(tools).toEqual([]);
    expect(logs).toEqual([{ text: expect.stringContaining(REGISTRATION_REFUSED) as unknown, options: { to: "debug" } }]);
    expect(logs[0]!.text).toMatch(/context_usage is not offered in this session/);
    expect(answered).not.toEqual(FROM_SERVER);
    expect(answered.result).toMatch(/compacted when this turn ends/);
  });

  it.each([
    { what: "an interactive session", interactive: true },
    { what: "a session that is not interactive", interactive: false },
  ])("answers each call in $what with the three figures Claude Code has at the moment of that call", async ({ interactive }) => {
    const { calls, usage } = await modSetup({ interactive });
    const explanation =
      "These are the input tokens of this session's latest model request, uncached, cache-written and cache-read together, as Claude Code's status line gives them (context_window.total_input_tokens).";

    const first = await calls(USAGE_TOOL);
    usage.answer = () => Promise.resolve({ ...MEASURED, context: { tokens: 190000, window: 1000000, percent: 19 } });
    const second = await calls(USAGE_TOOL);

    expect(first).toEqual({ result: `Context: 58965 input tokens of a 1000000-token window (6%). ${explanation}` });
    expect(second).toEqual({ result: `Context: 190000 input tokens of a 1000000-token window (19%). ${explanation}` });
  });

  it.each([
    { what: "has no input figure and no share, as before the first response of a fresh or just-compacted window", context: { window: 1000000 } },
    { what: "has an input figure but no share", context: { tokens: 58965, window: 1000000 } },
  ])("answers with an error and no figure when Claude Code $what", async ({ context }) => {
    const { calls, usage } = await modSetup();
    usage.answer = () => Promise.resolve({ ...MEASURED, context });

    const answered = (await calls(USAGE_TOOL)) as { result?: string; deny?: string };

    expect(answered.result).toBeUndefined();
    expect(answered.deny).toMatch(/size of this session's context is not known/i);
    expect(answered.deny).not.toMatch(/\d/);
  });

  it("answers with an error that gives Claude Code's reason, and no figure, when Claude Code fails to report the figures", async () => {
    const { calls, usage } = await modSetup();
    // In the form Claude Code 2.1.322 rejects a mod's other calls with (see TURN_IN_PROGRESS).
    const reason = "cc-session-pool: $.session.usage: the session is not bound";
    usage.answer = () => Promise.reject(new Error(reason));

    const answered = (await calls(USAGE_TOOL)) as { result?: string; deny?: string };

    expect(answered.result).toBeUndefined();
    expect(answered.deny).toContain(reason);
  });

  it("is refused, with no figure, when a subagent makes the call", async () => {
    const { calls } = await modSetup();

    const answered = (await calls(USAGE_TOOL, "agent-7")) as { result?: string; deny?: string };

    expect(answered.result).toBeUndefined();
    expect(answered.deny).toMatch(/only the session itself can call context_usage/i);
    expect(answered.deny).not.toMatch(/\d/);
  });
});
