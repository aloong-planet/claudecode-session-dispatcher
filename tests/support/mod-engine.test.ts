/**
 * The fake engine's file read (mod-engine.ts) against what Claude Code 2.1.327 answered a probe mod with
 * (~/research/claude-code-session-pool/monitor-reports-2026-11-26, out/fsread-text.jsonl and out/fsread-bytes.jsonl): the same
 * files, the same options, the same answers or refusals.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "./mod-engine.ts";
import { cleanUpTemporaryDirectories, temporaryDirectory } from "./temporary.ts";

afterAll(cleanUpTemporaryDirectories);

const MiB = 1_048_576;

/** The probe's files, made once for the file and only read: 4 MiB, 4 MiB and one byte, 5 MiB of ASCII, and `ab中cd`, whose 中 is bytes 2 to 4. */
function makeFiles() {
  const directory = temporaryDirectory();
  const made = { f4m: join(directory, "f4m.txt"), f4m1: join(directory, "f4m1.txt"), f5m: join(directory, "f5m.txt"), mb: join(directory, "mb.txt") };
  writeFileSync(made.f4m, "a".repeat(4 * MiB));
  writeFileSync(made.f4m1, "a".repeat(4 * MiB + 1));
  writeFileSync(made.f5m, "b".repeat(5 * MiB));
  writeFileSync(made.mb, "ab中cd");
  return made;
}

type Files = ReturnType<typeof makeFiles>;
let made: Files;
beforeAll(() => void (made = makeFiles()));
const answer = (path: string, options?: Parameters<typeof readFile>[1]) => {
  try {
    const read = readFile(path, options);
    return typeof read === "string" ? { chars: read.length, text: read.length > 16 ? undefined : read } : { base64: read.base64.length };
  } catch (error) {
    return { refused: String(error).replace(/^.*?(refused: |takes length)/, "$1") };
  }
};

describe("the fake engine's file read, as Claude Code 2.1.327's", () => {
  it.each<[string, (made: Files) => unknown, unknown]>([
    ["reads a file of exactly 4 MiB whole", (m) => answer(m.f4m), { chars: 4 * MiB }],
    ["refuses a file of 4 MiB and one byte read whole", (m) => answer(m.f4m1), { refused: "refused: the file is over the 4194304-byte limit" }],
    ["refuses a file of 5 MiB read whole", (m) => answer(m.f5m), { refused: "refused: the file is over the 4194304-byte limit" }],
    ["reads a range of 4 MiB", (m) => answer(m.f5m, { offset: 0, length: 4 * MiB }), { chars: 4 * MiB }],
    ["refuses a length over 4 MiB", (m) => answer(m.f5m, { offset: 0, length: 4 * MiB + 1 }), { refused: "takes length, a whole number of bytes from 0 to 4194304 (got 4194305) (host check)" }],
    ["reads the rest after an offset when it is 4 MiB", (m) => answer(m.f5m, { offset: MiB }), { chars: 4 * MiB }],
    [
      "refuses the rest after an offset when it is over 4 MiB",
      (m) => answer(m.f5m, { offset: MiB - 1 }),
      { refused: "refused: what follows offset 1048575 is over the 4194304-byte limit; pass length" },
    ],
    ["answers fewer bytes where the file ends first", (m) => answer(m.f5m, { offset: 5 * MiB - 20, length: 4 * MiB }), { chars: 20, text: undefined }],
    ["answers nothing past the end", (m) => answer(m.f5m, { offset: 10 * MiB, length: 10 }), { chars: 0, text: "" }],
    ["gives U+FFFD where a range's end cuts a character after its first byte", (m) => answer(m.mb, { offset: 0, length: 3 }), { chars: 3, text: "ab�" }],
    ["gives U+FFFD where a range's end cuts a character after its second byte", (m) => answer(m.mb, { offset: 0, length: 4 }), { chars: 3, text: "ab�" }],
    ["gives U+FFFD for each byte of a character before a range's start", (m) => answer(m.mb, { offset: 3, length: 4 }), { chars: 4, text: "��cd" }],
    ["gives U+FFFD for the last byte of a character at a range's start", (m) => answer(m.mb, { offset: 4, length: 3 }), { chars: 3, text: "�cd" }],
    ["answers a range of 4 MiB as base64", (m) => answer(m.f5m, { as: "bytes", offset: 0, length: 4 * MiB }), { base64: 5_592_408 }],
    ["refuses bytes of a file over 4 MiB read whole", (m) => answer(m.f4m1, { as: "bytes" }), { refused: "refused: the file is over the 4194304-byte limit" }],
  ])("%s", (_, read, expected) => {
    expect(read(made)).toEqual(expected);
  });

  it("answers the bytes of a range that cuts a character as they are", () => {
    const { mb } = made;

    const read = readFile(mb, { as: "bytes", offset: 3, length: 3 });

    expect(read).toEqual({ base64: Buffer.from([0xb8, 0xad, 0x63]).toString("base64") });
  });
});
