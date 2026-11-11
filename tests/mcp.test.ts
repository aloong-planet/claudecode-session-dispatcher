/**
 * The tools as an MCP client sees them: the real server object over an in-memory channel, on a pool that runs on
 * `FakeMac`. Each case proves that a tool's arguments reach the pool and that its outcome comes back; the rules
 * themselves are covered in `claude-session-pool.test.ts`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { FileTranscripts } from "../src/adapters/transcripts.ts";
import { createServer } from "../src/mcp.ts";
import { Pool } from "../src/pool.ts";
import { FakeMac } from "./support/fake-mac.ts";

const temporaryDirectories: string[] = [];
const fakes: FakeMac[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function connect() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
  temporaryDirectories.push(home);
  const directory = join(home, "project");
  const transcriptRoot = join(home, "transcripts");
  for (const path of [directory, transcriptRoot]) mkdirSync(path);
  const mac = new FakeMac();
  fakes.push(mac);
  mac.transcriptRoot = transcriptRoot;
  const pool = new Pool({
    directory,
    dispatcherPid: 4242,
    rosterRoot: join(home, "rosters"),
    sessions: mac.lister,
    terminal: mac.terminal,
    processes: mac.processes,
    transcripts: new FileTranscripts(transcriptRoot),
    clock: mac.clock,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(pool).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { isError: result.isError === true, text: content.map((part) => part.text).join("\n") };
  };
  return { mac, call, directory };
}

describe("the MCP server", () => {
  it("init opens every name in the list it is given", async () => {
    const { mac, call } = await connect();

    const result = await call("init", { names: ["w1", "w2"], model: "sonnet", permissionMode: "plan" });

    expect(result.isError).toBe(false);
    expect([mac.session("w1").model, mac.session("w2").model]).toEqual(["sonnet", "sonnet"]);
    expect([mac.session("w1").permissionMode, mac.session("w2").permissionMode]).toEqual(["plan", "plan"]);
  });

  it("open passes the name, the model and the permission mode", async () => {
    const { mac, call } = await connect();

    const result = await call("open", { name: "w1", model: "sonnet", permissionMode: "plan" });

    expect(result.isError).toBe(false);
    expect([mac.session("w1").model, mac.session("w1").permissionMode]).toEqual(["sonnet", "plan"]);
  });

  it("adopt and status act on the named session", async () => {
    const { mac, call, directory } = await connect();
    const session = mac.addSession({ name: "w1", cwd: directory });
    mac.addSession({ name: "w2", cwd: directory });

    const adopted = await call("adopt", { name: "w1" });
    const status = await call("status");

    expect(adopted.isError).toBe(false);
    expect(status).toEqual({ isError: false, text: `w1: idle, session ${session.sessionId}` });
  });

  it("clear resets the named slot", async () => {
    const { mac, call } = await connect();
    await call("init", { names: ["w1", "w2"] });
    const before = [mac.session("w1").sessionId, mac.session("w2").sessionId];

    const result = await call("clear", { name: "w2" });

    expect(result.isError).toBe(false);
    expect(mac.session("w1").sessionId).toBe(before[0]);
    expect(mac.session("w2").sessionId).not.toBe(before[1]);
  });

  it("compact passes the time limit", async () => {
    const { mac, call } = await connect();
    await call("open", { name: "w1" });
    mac.appendTurnRecord(mac.session("w1").sessionId!);
    mac.compactEffect = "busy-forever";
    const start = mac.now;

    const result = await call("compact", { name: "w1", timeoutMinutes: 5 });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^unconfirmed: /);
    expect(mac.now - start).toBe(300_000);
  });

  it("close passes force", async () => {
    const { mac, call } = await connect();
    await call("open", { name: "w1" });
    const session = mac.session("w1");
    session.status = "busy";

    const result = await call("close", { name: "w1", force: true });

    expect(result.isError).toBe(false);
    expect(mac.terminated).toEqual([session.pid]);
  });

  it("recycle passes force, the model and the permission mode", async () => {
    const { mac, call } = await connect();
    await call("open", { name: "w1" });
    const old = mac.session("w1");
    old.status = "busy";

    const result = await call("recycle", { name: "w1", force: true, model: "sonnet", permissionMode: "plan" });

    expect(result.isError).toBe(false);
    expect(mac.terminated).toEqual([old.pid]);
    expect([mac.session("w1").model, mac.session("w1").permissionMode]).toEqual(["sonnet", "plan"]);
  });

  it("release removes the named slot and no other", async () => {
    const { mac, call } = await connect();
    await call("init", { names: ["w1", "w2"] });

    const result = await call("release", { name: "w1" });

    expect(result.isError).toBe(false);
    expect(await call("status")).toEqual({ isError: false, text: `w2: idle, session ${mac.session("w2").sessionId}` });
  });

  it("returns a refusal as a tool error whose text gives the reason", async () => {
    const { call } = await connect();

    const result = await call("clear", { name: "stranger" });

    expect(result).toEqual({ isError: true, text: '"stranger" is not a slot in this pool\'s roster; nothing was done.' });
  });
});
