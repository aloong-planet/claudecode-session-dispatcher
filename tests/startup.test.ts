/**
 * What the start-up command adds to the arguments it was given: the rules, as a function of the arguments, the
 * directory, the sessions on this Mac, what the resumed session's transcript shows and the installed plugins. The command itself, as a
 * process, is covered in `claude-session-pool-startup.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { NameState } from "../src/adapters/transcripts.ts";
import type { InstalledPlugin, SessionEntry } from "../src/ports.ts";
import { startupArguments } from "../src/startup.ts";

const SESSION = "c97a8f9a-26a0-473f-8829-eeb79f7298e0";
const PLUGIN = ["--plugin-dir", "/repo/plugin"];

type Situation = {
  directory?: string;
  pluginDirectory?: string;
  /** The sessions on this Mac, or the reason why they cannot be listed. */
  sessions?: SessionEntry[] | string;
  nameState?: NameState;
  /** The installed plugins, or the reason why they cannot be listed. */
  plugins?: InstalledPlugin[] | string;
  /** Symbolic links: a path, and the path it resolves to. */
  links?: Record<string, string>;
};

function added(
  given: string[],
  {
    directory = "/Users/someone/git/codex-agents",
    pluginDirectory = "/repo/plugin",
    sessions = [],
    nameState = "unknown",
    plugins = [],
    links = {},
  }: Situation = {},
) {
  const notices: string[] = [];
  const result = startupArguments(given, {
    directory,
    pluginDirectory,
    sessions: { list: () => (typeof sessions === "string" ? Promise.reject(new Error(sessions)) : Promise.resolve(sessions)) },
    nameState: () => nameState,
    plugins: { installed: () => (typeof plugins === "string" ? Promise.reject(new Error(plugins)) : Promise.resolve(plugins)) },
    realPath: (path) => links[path] ?? path,
    notice: (line) => notices.push(line),
  });
  return { result, notices };
}

const live = (name: string, overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  kind: "interactive",
  cwd: "/Users/someone/elsewhere",
  pid: 7321,
  name,
  sessionId: "78744021-cd3b-490e-b601-5575fbb91cd6",
  status: "idle",
  ...overrides,
});

describe("the arguments the start-up command adds", () => {
  it.each([
    { what: "no arguments", given: [] },
    { what: "options and a prompt", given: ["--model", "opus", "plan the next ticket"] },
    { what: "a session ID chosen for the new session", given: ["--session-id", SESSION] },
  ])("names a new session after the directory when given $what", async ({ given }) => {
    expect(await added(given).result).toEqual(["--name=codex-agents-dispatcher", ...PLUGIN]);
  });

  it.each([
    { given: ["--resume", SESSION] },
    { given: ["-r", SESSION] },
    { given: [`--resume=${SESSION}`] },
    { given: ["--model", "opus", "--resume", SESSION.toUpperCase(), "carry on"] },
  ])("names a session resumed by ID with $given when its transcript shows no name", async ({ given }) => {
    expect(await added(given, { nameState: "unnamed" }).result).toEqual(["--name=codex-agents-dispatcher", ...PLUGIN]);
  });

  it("adds no name to a session resumed by ID whose transcript shows one, whatever is running", async () => {
    const { result, notices } = added(["--resume", SESSION], { nameState: "named", sessions: "claude agents exited with code 1" });

    expect(await result).toEqual(PLUGIN);
    expect(notices).toEqual([]);
  });

  it("adds no name, and says so in one line, when the resumed session's transcript cannot be read", async () => {
    const { result, notices } = added(["--resume", SESSION], { nameState: "unknown", sessions: "claude agents exited with code 1" });

    expect(await result).toEqual(PLUGIN);
    expect(notices).toEqual([`claude-dispatcher: the transcript of session ${SESSION} could not be found or read, so no name was added.`]);
  });

  // In every row the sessions cannot be listed and the resumed session has no name: had the command gone on to
  // the default name, it would have been refused.
  it.each([
    { given: ["-n", "codex-agents-f9"] },
    { given: ["--name", "codex-agents-f9", "--resume", SESSION] },
    { given: ["--name=codex-agents-f9"] },
    { given: ["--resume"] },
    { given: ["-r"] },
    { given: ["--resume", "--model", "opus"] },
    { given: ["--resume", "codex-agents-f9"] },
    { given: ["--resume=codex-agents-f9"] },
    { given: ["-c"] },
    { given: ["--continue"] },
    { given: ["--resume", SESSION, "--fork-session"] },
    { given: ["--from-pr", "123"] },
    { given: ["--from-pr=123"] },
    { given: ["--teleport", SESSION] },
    { given: ["-p", "summarise the roster"] },
    { given: ["--print", "summarise the roster"] },
    { given: ["--bg", "work through the queue"] },
    { given: ["--background", "--resume", SESSION] },
    { given: ["--cloud", "plan the migration"] },
    { given: ["--environment", "ccpool_1"] },
    { given: ["--desktop", "--resume", SESSION] },
    { given: ["-h"] },
    { given: ["--help"] },
    { given: ["-v"] },
    { given: ["--version"] },
  ])("adds no name and lists no sessions when given $given", async ({ given }) => {
    const { result, notices } = added(given, { nameState: "unnamed", sessions: "claude agents exited with code 1" });

    expect(await result).toEqual(PLUGIN);
    expect(notices).toEqual([]);
  });

  it("refuses the default name when a live session in any directory already answers to it", async () => {
    const { result } = added([], { sessions: [live("codex-agents-f9"), live("codex-agents-dispatcher", { pid: 18_703, cwd: "/Users/someone/other" })] });

    await expect(result).rejects.toThrow(
      'A live session already answers to "codex-agents-dispatcher" (pid 18703, in /Users/someone/other). Nothing was started. Pass -n <name> to start under another name.',
    );
  });

  it("uses the default name when only a session that is not running has it", async () => {
    const finished = live("codex-agents-dispatcher", { kind: "background", pid: undefined });

    expect(await added([], { sessions: [finished, live("codex-agents-f9")] }).result).toEqual(["--name=codex-agents-dispatcher", ...PLUGIN]);
  });

  it("refuses the default name when the sessions cannot be listed", async () => {
    const { result } = added(["--resume", SESSION], { nameState: "unnamed", sessions: "claude agents exited with code 1" });

    await expect(result).rejects.toThrow(
      'The sessions on this Mac could not be listed (claude agents exited with code 1), so it could not be checked whether a live session already answers to "codex-agents-dispatcher". Nothing was started. Pass -n <name> to choose the name yourself.',
    );
  });

  it.each([
    { what: "a line break", directory: "/Users/someone/pool\n--dangerously-skip-permissions" },
    { what: "an escape character", directory: "/Users/someone/po\u001bol" },
  ])("builds no name from a directory name that contains $what", async ({ directory }) => {
    await expect(added([], { directory }).result).rejects.toThrow("contains a control character");
    expect(await added(["-n", "pool"], { directory }).result).toEqual(PLUGIN);
  });

  it("builds no name in the directory /, which has none", async () => {
    await expect(added([], { directory: "/" }).result).rejects.toThrow(
      "The directory / has no name, so no session name was built from it. Nothing was started. Pass -n <name>.",
    );
    expect(await added(["-n", "pool"], { directory: "/" }).result).toEqual(PLUGIN);
  });

  it.each([
    { what: "a line break", pluginDirectory: "/Users/someone/tools\n--dangerously-skip-permissions/plugin" },
    { what: "an escape character", pluginDirectory: "/Users/someone/to\u001bols/plugin" },
  ])("adds nothing when the path of the plugin's directory contains $what, whatever it was given", async ({ pluginDirectory }) => {
    for (const given of [[], ["-n", "pool"], ["--help"]]) {
      await expect(added(given, { pluginDirectory }).result).rejects.toThrow(/contains a control character, so it could not be passed to claude\. Nothing was started\.$/);
    }
  });

  it("passes a plugin directory whose path holds spaces and quotes as one argument", async () => {
    const pluginDirectory = "/Users/someone/my tools/it's \"here\"/plugin";

    expect(await added(["-n", "pool"], { pluginDirectory }).result).toEqual(["--plugin-dir", pluginDirectory]);
  });

  it.each([
    { directory: "/Users/someone/my pool", name: "my pool-dispatcher" },
    { directory: "/Users/someone/-x", name: "-x-dispatcher" },
  ])("builds the name $name in the directory $directory, as one argument", async ({ directory, name }) => {
    expect(await added([], { directory }).result).toEqual([`--name=${name}`, ...PLUGIN]);
  });
});

describe("whether the start-up command loads the plugin itself", () => {
  const installed = (overrides: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
    id: "cc-session-pool@cc-session-pool",
    enabled: true,
    readFromFolder: "/repo/plugin",
    ...overrides,
  });

  it.each([
    { what: "a new session", given: [], expected: ["--name=codex-agents-dispatcher"] },
    { what: "a session given a name", given: ["-n", "pool"], expected: [] },
  ])("leaves the plugin to an installation that is enabled here and reads this repository's plugin, for $what", async ({ given, expected }) => {
    const { result, notices } = added(given, { plugins: [installed()] });

    expect(await result).toEqual(expected);
    expect(notices).toEqual([]);
  });

  it("takes an installation that reads this repository's plugin through a symbolic link as reading it", async () => {
    const plugins = [installed({ readFromFolder: "/Users/someone/link-to-repo/plugin" })];

    expect(await added(["-n", "pool"], { plugins, links: { "/Users/someone/link-to-repo/plugin": "/repo/plugin" } }).result).toEqual([]);
  });

  it.each([
    { what: "the plugin is not installed", plugins: [installed({ id: "superpowers@superpowers-marketplace" })] },
    { what: "the installation is not enabled in this directory", plugins: [installed({ enabled: false })] },
    { what: "the installation reads another copy of the plugin", plugins: [installed({ readFromFolder: "/Users/someone/other-checkout/plugin" })] },
    { what: "the installation reads no directory in place", plugins: [installed({ readFromFolder: undefined })] },
  ])("loads the plugin for the session when $what", async ({ plugins }) => {
    const { result, notices } = added(["-n", "pool"], { plugins });

    expect(await result).toEqual(PLUGIN);
    expect(notices).toEqual([]);
  });

  it.each([
    { given: ["--restricted"] },
    { given: ["--setting-sources", "project"] },
    { given: ["--setting-sources=project,local"] },
    { given: ["--settings", '{"enabledPlugins":{"cc-session-pool@cc-session-pool":false}}'] },
    { given: ["--settings=/Users/someone/settings.json"] },
  ])("loads the plugin for the session when it is given $given, with which the session may leave the installation out", async ({ given }) => {
    const { result, notices } = added(["-n", "pool", ...given], { plugins: [installed()] });

    expect(await result).toEqual(PLUGIN);
    expect(notices).toEqual([]);
  });

  it.each([
    { what: "the plugins cannot be listed", plugins: "claude plugin exited with code 1", reason: "claude plugin exited with code 1" },
    { what: "the listing does not say whether the plugin is enabled", plugins: [installed({ enabled: "yes" })], reason: '`claude plugin list --json` printed "yes" for whether cc-session-pool@cc-session-pool is enabled' },
  ])("loads the plugin for the session, and says why, when $what", async ({ plugins, reason }) => {
    const { result, notices } = added(["-n", "pool"], { plugins });

    expect(await result).toEqual(PLUGIN);
    expect(notices).toEqual([
      `claude-dispatcher: it could not be found out whether the cc-session-pool@cc-session-pool plugin is installed (${reason}), so it is loaded for this session with --plugin-dir.`,
    ]);
  });
});
