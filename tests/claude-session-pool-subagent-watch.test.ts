/**
 * The subagent watch: what the plugin's mod finds of the session's subagents at its looks and the reports it makes of them,
 * in the fake engine of `support/mod-engine.ts`, which lists subagents in the form Claude Code 2.1.327 listed them to a mod
 * and lays their transcripts out as it did. When a report waits and how progress is found are covered in
 * `claude-session-pool-plugin.test.ts`.
 *
 * Not covered here, because it needs a real Claude Code session: that Claude Code lists a subagent as the fake does while
 * it waits on a permission, on a subagent of its own or inside a long tool call. These were measured by hand on Claude Code
 * 2.1.327 (the ticket's delivery note) and are to be measured again when Claude Code changes how it lists agents.
 */
import { afterEach, describe, expect, it } from "vitest";
import { modSetup, type ListedAgent } from "./support/mod-engine.ts";
import { cleanUpTemporaryDirectories } from "./support/temporary.ts";

afterEach(cleanUpTemporaryDirectories);

const SUBAGENT = "a8c24a82d67a3ee4c";
const FIRST_LINE =
  "Report of the subagent watch, written by the cc-session-pool plugin. It is not a message from the user. Subagents of this session that need attention:";
const LAST_LINE = "Nothing was done to any subagent. Each of these is reported once.";
type Mod = Awaited<ReturnType<typeof modSetup>>;

/** Makes `count` looks, one at a time, and answers the looks after which there were more prompts than before. */
async function promptedAt(mod: Mod, count: number, at: Record<number, (mod: Mod) => void> = {}): Promise<number[]> {
  const prompted: number[] = [];
  for (let made = 1; made <= count; made += 1) {
    at[made]?.(mod);
    const before = mod.prompts.length;
    await mod.look();
    if (mod.prompts.length > before) prompted.push(made);
  }
  return prompted;
}

describe("a look", () => {
  it("judges the subagents Claude Code lists as running a turn, those a subagent started among them, and reports the stalled ones in the stated text (claude-session-pool-subagent-watch::US-001/AC-01, claude-session-pool-plugin::REQ-005/AC-04)", async () => {
    const { startSubagent, look, prompts } = await modSetup();
    startSubagent(SUBAGENT, { description: "sleep probe" });
    startSubagent("a41633a00e77a2aa3", { description: "parent probe", status: "waiting", taskStatus: "completed" });
    startSubagent("ac6e54f1181cbb956", { type: "Explore", description: "child probe", parentId: "a41633a00e77a2aa3" });
    startSubagent("a7e59383cccdb1fe1", { description: "permission probe", status: "completed", taskStatus: "completed" });
    startSubagent("researcher@probe-team", { type: "teammate", description: "Read the specs", kind: "in_process_teammate", teammateId: "researcher@probe-team" });

    await look(12);

    expect(prompts).toEqual([
      [
        FIRST_LINE,
        `- ${SUBAGENT} (general-purpose, "sleep probe"): running, and neither its transcript nor its token count changed for 11 minutes.`,
        `- ac6e54f1181cbb956 (Explore, "child probe"): running, and neither its transcript nor its token count changed for 11 minutes.`,
        LAST_LINE,
      ].join("\n"),
    ]);
  });

  it.each([
    { what: "lists it as waiting", at6: (mod: Mod) => void (mod.agents.listed[0]!.status = "waiting"), at7: (mod: Mod) => void (mod.agents.listed[0]!.status = "running") },
    {
      what: "is not given the list by Claude Code, and reports nothing of that (claude-session-pool-subagent-watch, \"does not give the list of subagents\")",
      at6: (mod: Mod) => void (mod.agents.fails = true),
      at7: (mod: Mod) => void (mod.agents.fails = false),
    },
    (() => {
      let kept: ListedAgent[] = [];
      return {
        what: "is given something that is not a list, and reports nothing of that (claude-session-pool-subagent-watch, \"does not give the list of subagents\")",
        at6: (mod: Mod) => {
          kept = mod.agents.listed;
          mod.agents.listed = { agents: kept } as never;
        },
        at7: (mod: Mod) => void (mod.agents.listed = kept),
      };
    })(),
  ])("that $what starts the count of a subagent anew (claude-session-pool-subagent-watch::US-001/AC-02)", async ({ at6, at7 }) => {
    const mod = await modSetup();
    mod.startSubagent(SUBAGENT);

    const prompted = await promptedAt(mod, 25, { 6: at6, 7: at7 });

    expect(prompted).toEqual([18]);
    expect(mod.prompts[0]).toContain(`- ${SUBAGENT} `);
  });
});

describe("a stall", () => {
  it("is reported once, a stall after progress again is a new one, and nothing is reported when the subagent progresses or ends (claude-session-pool-subagent-watch::US-001/AC-03, claude-session-pool-plugin::REQ-006)", async () => {
    const mod = await modSetup();
    mod.startSubagent(SUBAGENT);

    const prompted = await promptedAt(mod, 60, {
      31: ({ agents }) => void (agents.listed[0]!.tokenCount = 48_524),
      45: ({ agents }) => void agents.listed.splice(0),
    });

    expect(prompted).toEqual([12, 42]);
  });

  it("of a subagent in the foreground of a turn is not reported when the subagent ends with the turn (claude-session-pool-subagent-watch, \"foreground\")", async () => {
    const { agents, startSubagent, turnStarts, turnEnds, look, prompts } = await modSetup();
    startSubagent(SUBAGENT);
    await turnStarts();
    await look(14);

    agents.listed.splice(0);
    await turnEnds();
    await look(3);

    expect(prompts).toEqual([]);
  });
});

describe("the watch", () => {
  it("only reads what Claude Code lists of the subagents and the sizes of their transcripts, and reports to its own session (claude-session-pool-subagent-watch::CON-001)", async () => {
    const { engineCalls, startSubagent, look, prompts } = await modSetup();
    startSubagent(SUBAGENT);
    startSubagent("ac6e54f1181cbb956", { parentId: SUBAGENT });
    const atStart = engineCalls.length;

    await look(14);

    expect(prompts).toHaveLength(1);
    expect(new Set(engineCalls.slice(atStart))).toEqual(new Set(["agent.list", "session.info", "fs.list", "prompt.submit"]));
    expect(engineCalls.filter((call) => call === "prompt.submit")).toHaveLength(1);
  });
});

describe("the line of a stalled subagent", () => {
  const LINE_END = ": running, and neither its transcript nor its token count changed for 11 minutes.";
  it.each([
    { what: "a description with a line break", fields: { description: "Run the\ntest suite" }, named: `${SUBAGENT} (general-purpose)` },
    { what: "a description with a backtick", fields: { description: "Run `pnpm test`" }, named: `${SUBAGENT} (general-purpose)` },
    { what: "a description of 65 characters", fields: { description: "d".repeat(65) }, named: `${SUBAGENT} (general-purpose)` },
    { what: "a description of 64 characters", fields: { description: "d".repeat(64) }, named: `${SUBAGENT} (general-purpose, "${"d".repeat(64)}")` },
    { what: "every allowed character", fields: { type: "my-plugin:Agent_2.0", description: "Fix it: a-b_c.d" }, named: `${SUBAGENT} (my-plugin:Agent_2.0, "Fix it: a-b_c.d")` },
    { what: "a type that does not pass and a description that does", fields: { type: "plugin/agent" }, named: `${SUBAGENT} ("Run the test suite")` },
    { what: "neither passing", fields: { type: "", description: "Ünïcode" }, named: SUBAGENT },
    { what: "an ID with an underscore", fields: { id: "a8c24a82_d67a3ee4c" }, named: `a subagent (general-purpose, "Run the test suite")` },
  ])("leaves out what does not pass the stated form, given $what (claude-session-pool-subagent-watch, \"Text of a report\")", async ({ fields, named }) => {
    const { startSubagent, look, prompts } = await modSetup();
    startSubagent(fields.id ?? SUBAGENT, fields);

    await look(12);

    expect(prompts[0]!.split("\n")[1]).toBe(`- ${named}${LINE_END}`);
  });
});
