/**
 * Where someone is in the first-run guide, kept on this computer so a
 * restart part-way through comes back to the same step.
 *
 * No record at all means the guide has never run here: a new install, or
 * someone who had projects before it existed (boot marks those finished).
 */
export type SetupProgress = {
  /** Done: by a first chat, "I'll chat later!" or "Skip for now". */
  finished: boolean;
  /** Pressed Continue under the providers. */
  continued?: boolean | undefined;
  /** What the optional team step ended with. */
  team?: "loaded" | "skipped" | undefined;
};

const KEY = "thingmaker.setup";

export function readSetup(): SetupProgress | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SetupProgress> | null;
    if (!value || typeof value !== "object") return null;
    return {
      finished: value.finished === true,
      ...(value.continued === true ? { continued: true } : {}),
      ...(value.team === "loaded" || value.team === "skipped" ? { team: value.team } : {}),
    };
  } catch {
    return null;
  }
}

/** Merges `patch` into what is kept, and returns the result. */
export function writeSetup(patch: Partial<SetupProgress>): SetupProgress {
  // An undefined field is dropped by JSON, which is how a step reopens.
  const next = { ...(readSetup() ?? { finished: false }), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the guide still works for this run.
  }
  return next;
}

/** ⌘ on a Mac, Ctrl elsewhere, for the shortcuts the guide lists. */
export const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl+";
