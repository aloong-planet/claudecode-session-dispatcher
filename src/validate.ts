import { SLOT_NAME } from "../plugin/hooks/pool-rule.ts";

/** A condition under which a tool declines to act, or a step it could not confirm. Its message is the tool's error text. */
export class Refusal extends Error {}

const MODEL = /^[A-Za-z0-9._[\]-]{1,64}$/;
const PERMISSION_MODES = ["auto", "acceptEdits", "default", "plan", "dontAsk"];

export function checkSlotName(name: string): void {
  if (!SLOT_NAME.test(name)) {
    throw new Refusal(
      `"${name}" is not a valid slot name: use 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit.`,
    );
  }
}

export function checkModel(model: string): void {
  if (!MODEL.test(model)) {
    throw new Refusal(`"${model}" is not a valid model: use 1 to 64 letters, digits, ".", "_", "-", "[" or "]".`);
  }
}

export function checkPermissionMode(mode: string): void {
  if (!PERMISSION_MODES.includes(mode)) {
    throw new Refusal(`"${mode}" is not an allowed permission mode: use one of ${PERMISSION_MODES.join(", ")}.`);
  }
}

export function checkTimeoutMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Refusal(`timeoutMinutes must be a positive number, got ${minutes}.`);
  }
}
