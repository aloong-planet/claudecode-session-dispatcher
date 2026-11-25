// The pool's rules that the server and the plugin's mod both apply, written once: how Claude Code's session listing is
// read, which session a slot is and so which state it is in (docs/specs/claude-session-pool.md, "Which session a slot
// is"), the form of a roster's slots and a slot name, and the form of a look record ("Look records"). The server's
// `status` and the mod's looks take a slot's state from the same function, so that they agree.
//
// The mod loads this file, so it imports nothing (Claude Code gives a mod no modules) and is free of Node's interfaces.

/** One entry of Claude Code's session listing (`claude agents --json`). */
export type SessionEntry = {
  kind: string;
  cwd: string;
  pid?: number;
  name?: string;
  sessionId?: string;
  status?: string;
  waitingFor?: string;
};

/** claude-session-pool::CON-003/AC-01. */
export const SLOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The form of a session ID (docs/specs/claude-session-pool-startup.md, "Session IDs"). */
export const SESSION_ID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sessions on this Mac, from the text `claude agents --json` printed. Throws when that is not a list of sessions. */
export function parseSessionListing(text: string): SessionEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("`claude agents --json` did not print JSON, so the sessions on this Mac could not be listed.");
  }
  if (!Array.isArray(data)) throw new Error("`claude agents --json` did not print a list of sessions.");
  return data.flatMap((item: unknown) => {
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

export type LiveSession = SessionEntry & { pid: number };
export type Resolved = { state: "gone" } | { state: "ambiguous"; count: number } | { state: "live"; session: LiveSession };

/**
 * The state of the slot `name` in the listing `sessions`: its session is the live interactive entry of that name whose
 * directory, after `canonical` resolves its symbolic links, is the pool directory `directory` (already resolved).
 */
export function resolveSlot(sessions: readonly SessionEntry[], name: string, directory: string, canonical: (path: string) => string): Resolved {
  const matches = sessions.filter(
    (session): session is LiveSession => session.kind === "interactive" && session.pid !== undefined && session.name === name && canonical(session.cwd) === directory,
  );
  if (matches.length === 0) return { state: "gone" };
  if (matches.length > 1) return { state: "ambiguous", count: matches.length };
  return { state: "live", session: matches[0]! };
}

export type RosterSlot = {
  name: string;
  /** Whether the server opened a session for the slot or took over one the owner opened. */
  origin: "opened" | "adopted";
  /** For an opened slot: the process ID of the session the server opened, and with it of the window it opened. */
  pid?: number;
};

/** Whether `value` is a slot in the form a roster file holds it in. */
export function isRosterSlot(value: unknown): value is RosterSlot {
  if (typeof value !== "object" || value === null) return false;
  const { name, origin, pid } = value as Record<string, unknown>;
  return typeof name === "string" && (origin === "opened" || origin === "adopted") && (pid === undefined || typeof pid === "number");
}

/** A slot's entry in the pool's look record: what the last look that found the slot live found. */
export type LookEntry = { name: string; sessionId: string; state: "idle" | "busy" | "waiting"; seenAt: string; worked: boolean };

export const LOOK_STATES: readonly string[] = ["idle", "busy", "waiting"];
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function isLookEntry(value: unknown): value is LookEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { name, sessionId, state, seenAt, worked } = value as Record<string, unknown>;
  return (
    typeof name === "string" &&
    SLOT_NAME.test(name) &&
    typeof sessionId === "string" &&
    SESSION_ID_FORM.test(sessionId) &&
    typeof state === "string" &&
    LOOK_STATES.includes(state) &&
    typeof seenAt === "string" &&
    TIME.test(seenAt) &&
    !Number.isNaN(Date.parse(seenAt)) &&
    typeof worked === "boolean"
  );
}

/**
 * The entries of the look record `text` for the pool directory `directory`; undefined when the text is not a look record
 * of that directory in the form stated under "Look records", so that the pool counts as having none.
 */
export function parseLookRecord(text: string, directory: string): LookEntry[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const { version, directory: named, slots } = data as Record<string, unknown>;
  if (version !== 1 || named !== directory || !Array.isArray(slots) || !slots.every(isLookEntry)) return undefined;
  return slots.map(({ name, sessionId, state, seenAt, worked }) => ({ name, sessionId, state, seenAt, worked }));
}

/**
 * The key of a pool's files: the first 16 hexadecimal digits of the SHA-256 hash of the pool directory's path, already
 * resolved (docs/specs/claude-session-pool.md, "Roster file"). Computed here, without Node's modules or an asynchronous
 * digest, so that the server and the mod name the same files.
 */
export function poolKey(directory: string): string {
  return sha256(new TextEncoder().encode(directory)).slice(0, 16);
}

const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotateRight = (word: number, by: number): number => (word >>> by) | (word << (32 - by));

/** SHA-256 (FIPS 180-4) of `bytes`, in hexadecimal digits. */
function sha256(bytes: Uint8Array): string {
  const blocks = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  blocks.set(bytes);
  blocks[bytes.length] = 0x80;
  const view = new DataView(blocks.buffer);
  view.setUint32(blocks.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(blocks.length - 4, (bytes.length * 8) >>> 0);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words: number[] = new Array<number>(64).fill(0);
  for (let block = 0; block < blocks.length; block += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const early = words[i - 15]!;
      const late = words[i - 2]!;
      const s0 = rotateRight(early, 7) ^ rotateRight(early, 18) ^ (early >>> 3);
      const s1 = rotateRight(late, 17) ^ rotateRight(late, 19) ^ (late >>> 10);
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) + ((e & f) ^ (~e & g)) + ROUND_CONSTANTS[i]! + words[i]!) >>> 0;
      const t2 = ((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((word, i) => (hash[i] = (hash[i]! + word) >>> 0));
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}
